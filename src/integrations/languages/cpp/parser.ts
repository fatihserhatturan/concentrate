import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseSyntaxTreeSkippingErrors, type SyntaxNode } from "../syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../../../core/graph/model.js";
import type { LanguageParser } from "../../../core/contracts/language-parser.js";
import { walkScoped } from "../tree-sitter-utils.js";
import { cppNonCalls, normalizeCppType, type CppLocal } from "./types.js";

// Node types whose children are declarations or statements: one with a syntax
// error (often an unknown macro) is left out on its own, and the rest of the
// file is kept.
const statementParents = new Set([
  "translation_unit",
  "declaration_list",
  "field_declaration_list",
  "compound_statement",
  "enumerator_list",
  "preproc_if",
  "preproc_ifdef",
  "preproc_else",
  "preproc_elif",
  "preproc_elifdef",
  "linkage_specification",
]);

// Containers that hold declarations of the same scope.
const transparent = new Set(["preproc_if", "preproc_ifdef", "preproc_else", "preproc_elif", "preproc_elifdef", "declaration_list", "linkage_specification"]);
const classSpecifiers = new Set(["struct_specifier", "class_specifier", "union_specifier"]);

// Test frameworks whose macros define the test as a function body:
// GoogleTest `TEST(Suite, Name) { … }` and Catch2 `TEST_CASE("name", "[tag]") { … }`.
const gtestMacros = new Set(["TEST", "TEST_F", "TEST_P", "TYPED_TEST", "TYPED_TEST_P"]);
const catchMacros = new Set(["TEST_CASE", "SCENARIO", "TEST_CASE_METHOD", "TEMPLATE_TEST_CASE", "TEMPLATE_TEST_CASE_METHOD", "TEMPLATE_PRODUCT_TEST_CASE"]);
const catchSections = ["SECTION", "GIVEN", "WHEN", "THEN", "AND_GIVEN", "AND_WHEN", "AND_THEN"];

const catchArguments = String.raw`((?:\s*(?:"(?:[^"\\\n]|\\.)*"|[\w:]+)\s*,?)*)`;
const catchCaseRegex = new RegExp(String.raw`\b(?:${[...catchMacros].join("|")})\s*\(${catchArguments}\)(?=\s*\{)`, "gu");
const catchSectionRegex = new RegExp(String.raw`\b(${catchSections.join("|")})(\s*)\(${catchArguments}\)(?=\s*\{)`, "gu");
const hasCatch = new RegExp(`\\b(?:${[...catchMacros, ...catchSections].join("|")})\\s*\\(`, "u");

// Catch2 names its tests with string literals, which no declaration grammar
// reads: `TEST_CASE("a", "[b]") {` is read as `TEST_CASE(__, __) {` (a
// function) and `SECTION("a") {` as `if  (__) {`, the same length so
// positions stay (node text still comes from the source).
function catchStandIn(text: string): string {
  if (!hasCatch.test(text)) return text;
  const blankStrings = (args: string) => args.replace(/"(?:[^"\\\n]|\\.)*"/gu, (literal) => "_".repeat(literal.length));
  return text
    .replace(catchCaseRegex, (match) => {
      const open = match.indexOf("(");
      return `${match.slice(0, open + 1)}${blankStrings(match.slice(open + 1, match.lastIndexOf(")")))})`;
    })
    .replace(catchSectionRegex, (match, name: string, space: string, args: string) =>
      `${"if".padEnd(name.length, " ")}${space}(${blankStrings(args)})`);
}

// Export and calling-convention macros that stand before a name
// (`class TINYXML2_LIB XMLNode : …`, `static void * CJSON_CDECL f()`,
// `TINYXML2_CONSTANT int x`) are not part of the grammar; they are read as
// blanks of the same length.
const attributeMacro = /(?<!#[ \t]*define[ \t]+)(?<=^|[\s(,])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:API|LIB|EXPORT|EXPORTS|CDECL|STDCALL|CALL|DECL|CONSTANT|VISIBLE|PUBLIC|INLINE|NOINLINE|ATTR)\b(?=\s+[A-Za-z_*])/gmu;

// `#ifdef __cplusplus` / `extern "C" {` / `#endif` opens a block that only
// a second `#ifdef __cplusplus` / `}` / `#endif` closes; the grammar sees one
// brace of each, so both are read as blanks (line breaks stay).
const cplusplusGuard = String.raw`#[ \t]*if(?:def)?[ \t]+(?:defined[ \t]*\(?[ \t]*)?__cplusplus\)?[^\n]*\n\s*`;
const externCOpen = new RegExp(`(${cplusplusGuard})(extern\\s+"C"\\s*\\{)`, "gu");
const externCClose = new RegExp(`(${cplusplusGuard})\\}`, "gu");

const macroArguments = String.raw`(?:"(?:[^"\\\n]|\\.)*"|[^;{}\\#"()]|\((?:[^;{}()"]|"(?:[^"\\\n]|\\.)*")*\))*`;
const topLevelStatementMacro = new RegExp(String.raw`^[A-Z][A-Z0-9]*(?:_[A-Z0-9]*)+[ \t]*\(${macroArguments}\)[ \t]*(?=\r?\n\s*(?:[A-Za-z_#/}]|$))`, "gmu");

function cppStandIn(text: string): string {
  const blank = (match: string) => match.replace(/[^\r\n]/gu, " ");
  if (text.includes("__cplusplus")) {
    text = text.replace(externCOpen, (_match, guard: string, open: string) => `${guard}${blank(open)}`)
      .replace(externCClose, (_match, guard: string) => `${guard} `);
  }
  // Drogon's controller macros and Qt's `Q_OBJECT` are statements the grammar
  // reads as malformed declarations, and take the next declaration with them.
  if (text.includes("_LIST_") || text.includes("ADD_METHOD") || text.includes("METHOD_ADD") || text.includes("PATH_ADD") || text.includes("PATH_VIA_REGEX") || text.includes("Q_OBJECT")) {
    text = text
      .replace(/\b(?:METHOD_LIST_BEGIN|METHOD_LIST_END|PATH_LIST_BEGIN|PATH_LIST_END|WS_PATH_LIST_BEGIN|WS_PATH_LIST_END|Q_OBJECT|Q_GADGET)\b/gu, blank)
      .replace(/\b(?:METHOD_ADD|ADD_METHOD_TO|ADD_METHOD_VIA_REGEX|ADD_METHOD_VIA_REGEX_TO|PATH_ADD|WS_PATH_ADD|WS_ADD_PATH_VIA_REGEX|WS_CORO_PATH_ADD)\s*\([^;\\#]*\)\s*;/gu, blank);
  }
  // Flag declarations (`ABSL_FLAG(uint16_t, port, 50051, "…");`, gflags' `DEFINE_string`, googletest's `GTEST_DEFINE_bool_`)
  // are declarations without a type to the grammar and swallow what follows.
  if (text.includes("ABSL_") || text.includes("DEFINE_") || text.includes("DECLARE_")) {
    text = text.replace(/^[ \t]*(?:ABSL_FLAG|ABSL_DECLARE_FLAG|(?:[A-Z][A-Z0-9]*_)?(?:DEFINE|DECLARE)_(?:bool|string|int32|int64|uint32|uint64|double|int)_?)\s*\((?:"(?:[^"\\\n]|\\.)*"|[^;\\#"])*\)\s*;/gmu, blank);
  }
  // A statement macro at column 0 without a `;` (googletest's
  // `GTEST_REPEATER_METHOD_(OnTestStart, TestInfo)`, `GTEST_ATTRIBUTE_PRINTF_(2, 3)`
  // before a declaration) is an error to the grammar that takes the whole
  // enclosing namespace with it: it is read as blanks when the next line
  // starts a new declaration, directive or comment.
  if (text.includes("_(")) text = text.replace(topLevelStatementMacro, blank);
  return catchStandIn(text.replace(attributeMacro, blank).replace(/\b(class|struct|union)(\s+)([A-Z][A-Z0-9_]{2,})(?=\s+[A-Za-z_]\w*\s*(?:final\s*)?[:{])/gu, (_match, keyword: string, space: string, macro: string) => `${keyword}${space}${blank(macro)}`));
}

type Context = {
  scope: string[];
  className: string | null;
  classNode: GraphNode | null;
  access: string;
  anonymous: boolean;
  template: string | null;
};

export type CppLanguage = "c" | "cpp";

// Parse-time semantics a framework layer adds to a C or C++ file once its
// structure is built (routes, env reads, requests): it reads the written
// source (comments and strings included) and may add nodes and relationships.
export type CppParsePlugin = (file: {
  fileNodeId: string;
  relativePath: string;
  language: CppLanguage;
  source: string;
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}) => void;

export function createCppParser(language: CppLanguage, plugins: readonly CppParsePlugin[] = []): LanguageParser {
  return { language, parse: (rootPath, filePath) => parseCppFile(language, rootPath, filePath, plugins) };
}

export const cParser = createCppParser("c");
export const cppParser = createCppParser("cpp");

async function parseCppFile(language: CppLanguage, rootPath: string, filePath: string, plugins: readonly CppParsePlugin[]): Promise<ParsedSourceFile> {
  const source = await readFile(filePath, "utf8");
  const relativePath = path.relative(rootPath, filePath);
  const fileNodeId = `file:${relativePath}`;
  const fileNode: GraphNode = { id: fileNodeId, label: "File", properties: { path: filePath, relativePath, language } };
  const nodes: GraphNode[] = [fileNode];
  const relationships: GraphRelationship[] = [];
  const usedIds = new Set<string>([fileNodeId]);
  const namespaces = new Set<string>();
  const usingNamespaces: string[] = [];
  const usingNames: Array<{ name: string }> = [];
  const namespaceAliases: Record<string, string> = {};
  let hasTests = false;

  const { tree, skippedLines } = await parseSyntaxTreeSkippingErrors(language, source, statementParents, 4, cppStandIn);
  try {
    const uniqueId = (base: string, node: SyntaxNode) => {
      let id = base;
      if (usedIds.has(id)) id = `${base}:${node.startPosition.column}`;
      usedIds.add(id);
      return id;
    };
    const add = (node: GraphNode, from: string, type: GraphRelationship["type"]) => {
      nodes.push(node);
      relationships.push({ from, to: node.id, type, properties: {} });
    };

    const handleFunction = (node: SyntaxNode, context: Context, written: SyntaxNode | null = node.childForFieldName("declarator")) => {
      const declarator = functionDeclarator(written);
      if (!declarator) return;
      const nameNode = declarator.childForFieldName("declarator");
      if (!nameNode || nameNode.type === "parenthesized_declarator") return;
      const parts = nameParts(nameNode);
      if (parts.length === 0) return;
      const isDefinition = node.type === "function_definition";
      const typeNode = node.childForFieldName("type");

      // GoogleTest and Catch2 tests: a function-shaped macro without a return type.
      if (isDefinition && !typeNode && parts.length === 1 && context.className === null
        && (gtestMacros.has(parts[0]!) || catchMacros.has(parts[0]!))) {
        const testNode = createTestNode(fileNodeId, node, declarator, parts[0]!, context.scope);
        if (testNode) {
          hasTests = true;
          add(testNode, fileNodeId, "DEFINES_FUNCTION");
          addCalls(testNode, node, null, context, nodes, relationships, fileNodeId);
        }
        return;
      }

      const name = parts.at(-1)!;
      // `Foo::bar` outside its class (or `ns::f` outside its namespace): the
      // qualifier adds to the scope the declaration stands in.
      const scope = [...context.scope, ...parts.slice(0, -1)];
      const inClass = context.className !== null;
      const className = inClass ? context.className : parts.length > 1 ? parts.at(-2)! : null;
      const qualifiedName = [...scope, name].join("::");
      const isStatic = hasSpecifier(node, "static");
      const virtualSpecifiers = declarator.namedChildren.filter((child) => child.type === "virtual_specifier").map((child) => child.text);
      const isVirtual = node.children.some((child) => child.type === "virtual") || virtualSpecifiers.includes("override");
      const bareName = name.replace(/^~/u, "");
      const kind = name.startsWith("~") ? "destructor"
        : !typeNode && className !== null && bareName === className ? "constructor"
        : className !== null ? "method" : "function";
      const exported = !isStatic && !context.anonymous;
      const line = node.startPosition.row + 1;
      const functionNode: GraphNode = {
        id: uniqueId(`${fileNodeId}:function:${line}:${qualifiedName}`, node),
        label: "Function",
        properties: {
          name,
          kind,
          methodKind: null,
          line,
          endLine: node.endPosition.row + 1,
          className,
          isExported: exported,
          isAsync: false,
          isAbstract: isPureVirtual(node),
          visibility: inClass ? context.access : isStatic || context.anonymous ? "internal" : "external",
          parameters: JSON.stringify(cppParameters(declarator.childForFieldName("parameters"))),
          returnType: typeNode ? returnTypeOf(typeNode.text) : null,
          ...(context.template ? { typeParameters: context.template } : {}),
          namespace: scope.join("::"),
          qualifiedName,
          isVirtual,
          isOverride: virtualSpecifiers.includes("override"),
          isDeclaration: !isDefinition,
        },
      };
      if (inClass && context.classNode) add(functionNode, context.classNode.id, "DEFINES_METHOD");
      else add(functionNode, fileNodeId, "DEFINES_FUNCTION");

      if (!isDefinition) return;
      if (name === "main" && parts.length === 1 && context.scope.length === 0 && !isStatic) {
        const entrypoint: GraphNode = {
          id: `${fileNodeId}:entrypoint:${line}:${node.startPosition.column}:main:<none>`,
          label: "EntryPoint",
          properties: { kind: "main", trigger: null, receiverName: null, library: language, line, handlerName: "main" },
        };
        nodes.push(entrypoint);
        relationships.push(
          { from: fileNodeId, to: entrypoint.id, type: "DECLARES_ENTRYPOINT", properties: {} },
          { from: entrypoint.id, to: functionNode.id, type: "ENTRYPOINT_HANDLED_BY", properties: {} },
        );
      }
      addCalls(functionNode, node, className, { ...context, scope }, nodes, relationships, fileNodeId);
    };

    const handlePrototypes = (node: SyntaxNode, context: Context) => {
      const typeNode = node.childForFieldName("type");
      for (const declarator of node.childrenForFieldName("declarator")) {
        const inner = declarator.type === "init_declarator" ? declarator.childForFieldName("declarator") : declarator;
        const fn = functionDeclarator(inner);
        if (fn && fn.childForFieldName("declarator")?.type !== "parenthesized_declarator") {
          handleFunction(node, context, inner);
          continue;
        }
        if (context.className !== null || !inner) continue;
        // A file-level variable (functions' locals are not declarations).
        const name = declaratorName(inner);
        if (!name || hasSpecifier(node, "typedef")) continue;
        const line = declarator.startPosition.row + 1;
        const isStatic = hasSpecifier(node, "static");
        const variable: GraphNode = {
          id: uniqueId(`${fileNodeId}:variable:${line}:${[...context.scope, name].join("::")}`, declarator),
          label: "Variable",
          properties: {
            name,
            kind: hasSpecifier(node, "const") || hasSpecifier(node, "constexpr") ? "const" : "var",
            isExported: !isStatic && !context.anonymous,
            line,
            typeName: normalizeCppType(typeNode?.text) ?? typeNode?.text ?? null,
            visibility: isStatic || context.anonymous ? "internal" : "external",
          },
        };
        add(variable, fileNodeId, "DEFINES_VARIABLE");
      }
    };

    const handleClass = (node: SyntaxNode, context: Context, aliasName?: string): string | null => {
      const body = node.childForFieldName("body");
      if (!body) return null;
      const written = node.childForFieldName("name");
      const parts = written ? nameParts(written) : [];
      const name = parts.at(-1) ?? aliasName;
      if (!name) return null;
      const kind = node.type === "class_specifier" ? "class" : node.type === "union_specifier" ? "union" : "struct";
      const scope = [...context.scope, ...parts.slice(0, -1)];
      const line = node.startPosition.row + 1;
      const classNode: GraphNode = {
        id: uniqueId(`${fileNodeId}:class:${line}:${[...scope, name].join("::")}`, node),
        label: "Class",
        properties: {
          name,
          kind,
          line,
          endLine: node.endPosition.row + 1,
          isExported: !context.anonymous,
          isAbstract: false,
          visibility: null,
          bases: JSON.stringify(classBases(node, kind)),
          fields: "[]",
          ...(context.template ? { typeParameters: context.template } : {}),
          namespace: scope.join("::"),
          qualifiedName: [...scope, name].join("::"),
        },
      };
      add(classNode, fileNodeId, "DEFINES_CLASS");
      const fields: Array<{ name: string; type: string | null; access: string; isStatic: boolean }> = [];
      const inner: Context = {
        scope: [...scope, name],
        className: name,
        classNode,
        access: kind === "class" ? "private" : "public",
        anonymous: context.anonymous,
        template: null,
      };
      for (const member of body.namedChildren) {
        if (member.type === "access_specifier") {
          inner.access = member.text;
        } else if (member.type === "field_declaration" || member.type === "declaration") {
          const hasFunction = member.childrenForFieldName("declarator").some((declarator) => functionDeclarator(declarator.type === "init_declarator" ? declarator.childForFieldName("declarator") : declarator) !== null);
          if (hasFunction) {
            handlePrototypes(member, inner);
          } else {
            for (const declarator of member.childrenForFieldName("declarator")) {
              const field = declaratorName(declarator);
              if (field) fields.push({ name: field, type: normalizeCppType(member.childForFieldName("type")?.text), access: inner.access, isStatic: hasSpecifier(member, "static") });
            }
          }
          for (const specifier of member.namedChildren) if (classSpecifiers.has(specifier.type) || specifier.type === "enum_specifier") handleType(specifier, inner);
        } else {
          handleDeclaration(member, inner);
        }
      }
      classNode.properties.fields = JSON.stringify(fields);
      classNode.properties.isAbstract = nodes.some((candidate) => candidate.label === "Function" && candidate.properties.className === name
        && candidate.properties.namespace === [...scope, name].join("::") && candidate.properties.isAbstract === true && candidate.properties.isDeclaration === true);
      return name;
    };

    const handleEnum = (node: SyntaxNode, context: Context, aliasName?: string) => {
      const body = node.childForFieldName("body");
      const name = node.childForFieldName("name")?.text ?? aliasName;
      if (!body || !name) return;
      const line = node.startPosition.row + 1;
      add({
        id: uniqueId(`${fileNodeId}:enum:${line}:${[...context.scope, name].join("::")}`, node),
        label: "Enum",
        properties: {
          name,
          line,
          endLine: node.endPosition.row + 1,
          isExported: !context.anonymous,
          variants: JSON.stringify(body.namedChildren.filter((child) => child.type === "enumerator").map((child) => child.childForFieldName("name")?.text ?? child.text)),
          visibility: null,
          namespace: context.scope.join("::"),
          qualifiedName: [...context.scope, name].join("::"),
        },
      }, fileNodeId, "DEFINES_ENUM");
    };

    const handleType = (node: SyntaxNode, context: Context, aliasName?: string): string | null => {
      if (node.type === "enum_specifier") {
        handleEnum(node, context, aliasName);
        return null;
      }
      return handleClass(node, context, aliasName);
    };

    const addAlias = (name: string, target: string, node: SyntaxNode, context: Context, isAlias: boolean) => {
      const line = node.startPosition.row + 1;
      add({
        id: uniqueId(`${fileNodeId}:type:${line}:${[...context.scope, name].join("::")}`, node),
        label: "TypeAlias",
        properties: {
          name,
          line,
          endLine: node.endPosition.row + 1,
          isExported: !context.anonymous,
          aliasOf: target,
          isAlias,
          visibility: null,
          ...(context.template ? { typeParameters: context.template } : {}),
          namespace: context.scope.join("::"),
          qualifiedName: [...context.scope, name].join("::"),
        },
      }, fileNodeId, "DEFINES_TYPE_ALIAS");
    };

    const handleDeclaration = (node: SyntaxNode, context: Context): void => {
      switch (node.type) {
        case "preproc_include": {
          const target = node.childForFieldName("path");
          if (!target) return;
          const isSystem = target.type === "system_lib_string";
          const sourceText = isSystem ? target.text.slice(1, -1) : target.text.replace(/^"|"$/gu, "");
          add({
            id: `${fileNodeId}:import:${node.startPosition.row + 1}:${sourceText}`,
            label: "Import",
            properties: { source: sourceText, specifier: node.text.trim(), line: node.startPosition.row + 1, isSystem },
          }, fileNodeId, "IMPORTS");
          return;
        }
        case "preproc_def": {
          const name = node.childForFieldName("name")?.text;
          if (!name) return;
          const value = node.childForFieldName("value")?.text.trim() ?? "";
          const line = node.startPosition.row + 1;
          add({
            id: uniqueId(`${fileNodeId}:variable:${line}:${name}`, node),
            label: "Variable",
            properties: {
              name,
              kind: "macro",
              isExported: false,
              line,
              ...(/^"(?:[^"\\]|\\.)*"$/u.test(value) && !value.includes("\\") ? { stringValue: value.slice(1, -1) } : {}),
              typeName: value.length > 0 && value.length <= 80 ? value : null,
            },
          }, fileNodeId, "DEFINES_VARIABLE");
          return;
        }
        case "preproc_function_def": {
          const name = node.childForFieldName("name")?.text;
          if (!name) return;
          const line = node.startPosition.row + 1;
          add({
            id: uniqueId(`${fileNodeId}:function:${line}:${name}`, node),
            label: "Function",
            properties: {
              name,
              kind: "macro",
              methodKind: null,
              line,
              endLine: node.endPosition.row + 1,
              className: null,
              isExported: false,
              isAsync: false,
              isAbstract: false,
              visibility: "external",
              parameters: JSON.stringify((node.childForFieldName("parameters")?.namedChildren ?? []).map((parameter) => ({ name: parameter.text, type: null }))),
              returnType: null,
              namespace: "",
              qualifiedName: name,
              isVirtual: false,
              isOverride: false,
              isDeclaration: false,
            },
          }, fileNodeId, "DEFINES_FUNCTION");
          return;
        }
        case "namespace_definition": {
          const body = node.childForFieldName("body");
          const written = node.childForFieldName("name");
          const parts = written ? written.text.split("::").map((part) => part.trim()).filter(Boolean) : [];
          const scope = [...context.scope, ...parts];
          if (parts.length > 0) {
            for (let depth = context.scope.length + 1; depth <= scope.length; depth += 1) namespaces.add(scope.slice(0, depth).join("::"));
          }
          if (body) for (const child of body.namedChildren) handleDeclaration(child, { ...context, scope, anonymous: context.anonymous || parts.length === 0 });
          return;
        }
        case "namespace_alias_definition": {
          const alias = node.childForFieldName("name")?.text;
          const target = node.namedChildren.find((child) => child.type !== "namespace_identifier" || child.text !== alias)?.text;
          if (alias && target) namespaceAliases[alias] = target.replace(/^::/u, "");
          return;
        }
        case "using_declaration": {
          const target = node.namedChildren.find((child) => child.type === "qualified_identifier" || child.type === "identifier" || child.type === "namespace_identifier");
          if (!target) return;
          const text = target.text.replace(/^::/u, "");
          if (node.children.some((child) => child.type === "namespace")) usingNamespaces.push(joinScope(context.scope, text));
          else usingNames.push({ name: text });
          return;
        }
        case "alias_declaration": {
          const name = node.childForFieldName("name")?.text;
          const target = node.childForFieldName("type")?.text;
          if (name && target) addAlias(name, normalizeCppType(target) ?? target, node, context, true);
          return;
        }
        case "type_definition": {
          const typeNode = node.childForFieldName("type");
          const declarators = node.childrenForFieldName("declarator");
          const names = declarators.map((declarator) => declaratorName(declarator)).filter((name): name is string => name !== null);
          if (!typeNode) return;
          if (classSpecifiers.has(typeNode.type) || typeNode.type === "enum_specifier") {
            const written = typeNode.childForFieldName("name")?.text;
            // `typedef struct { … } Name;` is the type Name.
            const defined = handleType(typeNode, context, written ? undefined : names[0]);
            const target = written ?? names[0];
            for (const name of names) if (target && name !== (defined ?? target) && name !== target) addAlias(name, target, node, context, false);
            if (written && typeNode.type === "enum_specifier") for (const name of names) if (name !== written) addAlias(name, written, node, context, false);
            return;
          }
          for (const name of names) addAlias(name, normalizeCppType(typeNode.text) ?? typeNode.text, node, context, false);
          return;
        }
        case "template_declaration": {
          const parameters = node.childForFieldName("parameters")?.text ?? null;
          for (const child of node.namedChildren) {
            if (child.type === "template_parameter_list") continue;
            handleDeclaration(child, { ...context, template: parameters });
          }
          return;
        }
        case "function_definition":
          handleFunction(node, context);
          return;
        case "declaration":
        case "field_declaration": {
          for (const specifier of node.namedChildren) {
            if (classSpecifiers.has(specifier.type) || specifier.type === "enum_specifier") handleType(specifier, context);
          }
          handlePrototypes(node, context);
          return;
        }
        default:
          if (classSpecifiers.has(node.type) || node.type === "enum_specifier") {
            handleType(node, context);
            return;
          }
          if (transparent.has(node.type)) for (const child of node.namedChildren) handleDeclaration(child, context);
      }
    };

    const root: Context = { scope: [], className: null, classNode: null, access: "public", anonymous: false, template: null };
    for (const child of tree.rootNode.namedChildren) handleDeclaration(child, root);

    const scopeProperties: Record<string, unknown> = {};
    if (namespaces.size > 0) scopeProperties.namespaces = [...namespaces];
    if (usingNamespaces.length > 0) scopeProperties.usingNamespaces = usingNamespaces;
    if (usingNames.length > 0) scopeProperties.usingNames = usingNames;
    if (Object.keys(namespaceAliases).length > 0) scopeProperties.namespaceAliases = namespaceAliases;
    if (Object.keys(scopeProperties).length > 0) fileNode.properties.cppScope = JSON.stringify(scopeProperties);
    if (hasTests) fileNode.properties.isTest = true;

    for (const plugin of plugins) plugin({ fileNodeId, relativePath, language, source, nodes, relationships });

    const parsed: ParsedSourceFile = { fileNodeId, nodes, relationships };
    if (skippedLines.length > 0) {
      parsed.warnings = [`Syntax error: left out the statement${skippedLines.length === 1 ? "" : "s"} at line${skippedLines.length === 1 ? "" : "s"} ${skippedLines.join(", ")}`];
    }
    return parsed;
  } finally {
    tree.delete();
  }
}

// `CJSON_PUBLIC(cJSON *)` is a cJSON * (an export macro that wraps the type).
function returnTypeOf(text: string): string {
  const unwrapped = /^[A-Z_][A-Z0-9_]*\((.+)\)$/u.exec(text.trim())?.[1] ?? text;
  return normalizeCppType(unwrapped) ?? unwrapped;
}

function joinScope(scope: string[], name: string): string {
  return scope.length === 0 ? name : `${scope.join("::")}::${name}`;
}

// Walks through pointer, reference and parenthesized declarators to the
// function declarator of `int *f(int)`; null for a variable.
function functionDeclarator(declarator: SyntaxNode | null): SyntaxNode | null {
  let current = declarator;
  for (let guard = 0; current && guard < 8; guard += 1) {
    if (current.type === "function_declarator") return current;
    if (!/(?:pointer|reference|parenthesized|attributed)_declarator$/u.test(current.type)) return null;
    current = current.childForFieldName("declarator") ?? current.namedChildren.find((child) => child.type.endsWith("declarator")) ?? null;
  }
  return null;
}

// The identifier a declarator declares (`*next`, `&r`, `buf[16]`, `(*cb)(int)`).
function declaratorName(declarator: SyntaxNode | null): string | null {
  let current = declarator;
  for (let guard = 0; current && guard < 10; guard += 1) {
    if (current.type === "identifier" || current.type === "field_identifier" || current.type === "type_identifier") return current.text;
    if (current.type === "qualified_identifier") return nameParts(current).at(-1) ?? null;
    current = current.childForFieldName("declarator") ?? current.namedChildren.find((child) => /declarator|identifier/u.test(child.type)) ?? null;
  }
  return null;
}

// `ns::Foo::bar` as ["ns", "Foo", "bar"]; template arguments are dropped.
function nameParts(node: SyntaxNode): string[] {
  if (node.type === "qualified_identifier") {
    const scope = node.childForFieldName("scope");
    const name = node.childForFieldName("name");
    return [...(scope ? [stripTemplate(scope.text)] : []), ...(name ? nameParts(name) : [])];
  }
  if (node.type === "template_function" || node.type === "template_method" || node.type === "template_type") {
    const name = node.childForFieldName("name");
    return name ? nameParts(name) : [stripTemplate(node.text)];
  }
  return [stripTemplate(node.text)];
}

function stripTemplate(text: string): string {
  const index = text.indexOf("<");
  return (index === -1 ? text : text.slice(0, index)).trim();
}

function hasSpecifier(node: SyntaxNode, name: string): boolean {
  return node.namedChildren.some((child) => (child.type === "storage_class_specifier" || child.type === "type_qualifier") && child.text === name)
    || (name === "constexpr" && node.children.some((child) => child.type === "constexpr"));
}

function isPureVirtual(node: SyntaxNode): boolean {
  const children = node.children;
  const equals = children.findIndex((child) => child.type === "=");
  return equals !== -1 && children[equals + 1]?.text === "0";
}

// `: public A, private virtual ns::B<T>` as [{name, access, virtual}].
function classBases(node: SyntaxNode, kind: string): Array<{ name: string; access: string; virtual: boolean }> {
  const clause = node.namedChildren.find((child) => child.type === "base_class_clause");
  const bases: Array<{ name: string; access: string; virtual: boolean }> = [];
  let access = kind === "class" ? "private" : "public";
  let isVirtual = false;
  for (const child of clause?.children ?? []) {
    if (child.type === ",") {
      access = kind === "class" ? "private" : "public";
      isVirtual = false;
    } else if (child.type === "access_specifier") {
      access = child.text;
    } else if (child.type === "virtual") {
      isVirtual = true;
    } else if (child.isNamed && ["type_identifier", "qualified_identifier", "template_type"].includes(child.type)) {
      bases.push({ name: nameParts(child).join("::"), access, virtual: isVirtual });
    }
  }
  return bases;
}

// `(int a, const Foo& b, ...)` as [{name, type}]; an unnamed parameter has a null name.
export function cppParameters(list: SyntaxNode | null): Array<{ name: string | null; type: string | null; optional?: true }> {
  const parameters: Array<{ name: string | null; type: string | null; optional?: true }> = [];
  // `...` is a `variadic_parameter` in C and a bare token in C++.
  for (const parameter of list?.children ?? []) {
    if (parameter.type === "variadic_parameter_declaration" || parameter.type === "variadic_parameter" || parameter.type === "...") {
      parameters.push({ name: null, type: "..." });
      continue;
    }
    if (parameter.type !== "parameter_declaration" && parameter.type !== "optional_parameter_declaration") continue;
    const typeNode = parameter.childForFieldName("type");
    if (typeNode?.text === "void" && !parameter.childForFieldName("declarator")) continue;
    parameters.push({ name: declaratorName(parameter.childForFieldName("declarator")), type: parameterType(parameter), ...(parameter.type === "optional_parameter_declaration" ? { optional: true as const } : {}) });
  }
  return parameters;
}

function parameterType(parameter: SyntaxNode): string | null {
  const typeNode = parameter.childForFieldName("type");
  if (!typeNode) return null;
  const qualifiers = parameter.namedChildren.filter((child) => child.type === "type_qualifier").map((child) => child.text).join(" ");
  const declarator = parameter.childForFieldName("declarator")?.text ?? "";
  const marks = declarator.replace(/[\w:]+/gu, "").replace(/[()]/gu, "");
  return `${qualifiers ? `${qualifiers} ` : ""}${typeNode.text}${marks}`.trim();
}

function createTestNode(fileNodeId: string, node: SyntaxNode, declarator: SyntaxNode, macro: string, scope: string[]): GraphNode | null {
  const parameters = declarator.childForFieldName("parameters");
  if (!parameters) return null;
  const texts = parameters.namedChildren.map((parameter) => parameter.text.trim());
  const isGtest = gtestMacros.has(macro);
  let name: string;
  if (isGtest) {
    if (texts.length < 2) return null;
    name = `${texts[0]}.${texts[1]}`;
  } else {
    const literal = /"((?:[^"\\\n]|\\.)*)"/u.exec(parameters.text);
    // TEST_CASE_METHOD(Fixture, "name") names the second argument.
    const named = [...parameters.text.matchAll(/"((?:[^"\\\n]|\\.)*)"/gu)].map((match) => match[1]!);
    name = (macro === "TEST_CASE_METHOD" ? named[0] : literal?.[1]) ?? texts[0] ?? macro;
  }
  const line = node.startPosition.row + 1;
  return {
    id: `${fileNodeId}:function:${line}:${macro}:${name}`,
    label: "Function",
    properties: {
      name,
      kind: "test",
      methodKind: null,
      line,
      endLine: node.endPosition.row + 1,
      className: null,
      isExported: false,
      isAsync: false,
      isAbstract: false,
      visibility: "internal",
      parameters: "[]",
      returnType: null,
      testKind: isGtest ? "gtest" : "catch2",
      namespace: scope.join("::"),
      qualifiedName: [...scope, name].join("::"),
      isVirtual: false,
      isOverride: false,
      isDeclaration: false,
    },
  };
}

// Calls of a function body, with what is known of each receiver.
function addCalls(
  functionNode: GraphNode,
  definition: SyntaxNode,
  className: string | null,
  context: Context,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  fileNodeId: string,
): void {
  void fileNodeId;
  const body = definition.childForFieldName("body");
  if (!body) return;
  const locals = readLocals(definition, body);
  void className;
  void context;
  walkScoped(body, (child) => {
    if (child.type !== "call_expression") return;
    const call = createCallNode(functionNode.id, child, locals);
    if (!call) return;
    nodes.push(call);
    relationships.push({ from: functionNode.id, to: call.id, type: "CALLS", properties: {} });
  }, (child) => child.type === "function_definition");
}

function createCallNode(functionNodeId: string, call: SyntaxNode, locals: ReadonlyMap<string, CppLocal | null>): GraphNode | null {
  const callee = call.childForFieldName("function");
  if (!callee) return null;
  let name: string;
  let receiver: string | null = null;
  let qualifier: string | null = null;
  let receiverCall: string | null = null;
  const expression = callee.text.replace(/\s+/gu, "");
  if (callee.type === "identifier") {
    name = callee.text;
  } else if (callee.type === "qualified_identifier" || callee.type === "template_function") {
    const parts = nameParts(callee);
    name = parts.at(-1)!;
    if (parts.length > 1) qualifier = parts.slice(0, -1).join("::");
    if (callee.text.startsWith("::") && qualifier === null) qualifier = "";
  } else if (callee.type === "field_expression") {
    const field = callee.childForFieldName("field");
    const argument = callee.childForFieldName("argument");
    if (!field || !argument) return null;
    name = nameParts(field).at(-1)!;
    receiver = argument.text.replace(/\s+/gu, "").replace(/->/gu, ".");
    if (argument.type === "call_expression") {
      const inner = argument.childForFieldName("function");
      if (inner && ["identifier", "qualified_identifier"].includes(inner.type)) receiverCall = `${nameParts(inner).join("::")}()`;
    }
  } else {
    return null;
  }
  if (cppNonCalls.has(name)) return null;
  const root = receiver === null ? undefined : receiver.split(".")[0]!;
  const local = root === undefined ? undefined : locals.get(root);
  const line = call.startPosition.row + 1;
  return {
    id: `${functionNodeId}:call:${line}:${call.startPosition.column}:${expression}`,
    label: "Call",
    properties: {
      name: expression,
      expression,
      callee: name,
      receiver,
      line,
      columnNumber: call.startPosition.column,
      argCount: call.childForFieldName("arguments")?.namedChildren.filter((argument) => argument.type !== "comment").length ?? 0,
      ...(qualifier === null ? {} : { qualifier }),
      ...(receiverCall !== null
        ? { receiverConstructor: receiverCall }
        : local === undefined ? {} : local === null ? { receiverIsLocal: true } : "type" in local ? { receiverType: local.type } : { receiverConstructor: local.constructor }),
    },
  };
}

// The parameters and the declarations of a function body: `T x`, `T* p`,
// `T& r`, `T x(…)`, `auto x = T(…)`, `new T`, `std::make_unique<T>(…)`.
function readLocals(definition: SyntaxNode, body: SyntaxNode): Map<string, CppLocal | null> {
  const locals = new Map<string, CppLocal | null>();
  const declarator = functionDeclarator(definition.childForFieldName("declarator"));
  for (const parameter of cppParameters(declarator?.childForFieldName("parameters") ?? null)) {
    const type = normalizeCppType(parameter.type);
    if (parameter.name) locals.set(parameter.name, type ? { type } : null);
  }
  walkScoped(body, (node) => {
    if (node.type !== "declaration" && node.type !== "condition_clause") return;
    const typeNode = node.childForFieldName("type");
    if (!typeNode) return;
    const declared = typeNode.type === "placeholder_type_specifier" || typeNode.text === "auto" ? null : normalizeCppType(typeNode.text);
    for (const declarator of node.childrenForFieldName("declarator")) {
      const name = declaratorName(declarator);
      if (!name) continue;
      if (declared) {
        locals.set(name, { type: declared });
      } else {
        const value = declarator.type === "init_declarator" ? declarator.childForFieldName("value") : null;
        locals.set(name, valueType(value, locals));
      }
    }
  }, (child) => child.type === "lambda_expression" || child.type === "function_definition");
  return locals;
}

function valueType(value: SyntaxNode | null, locals: ReadonlyMap<string, CppLocal | null>): CppLocal | null {
  if (!value) return null;
  if (value.type === "new_expression") {
    const type = normalizeCppType(value.childForFieldName("type")?.text);
    return type ? { type } : null;
  }
  if (value.type === "identifier") return locals.get(value.text) ?? null;
  if (value.type === "pointer_expression") return valueType(value.childForFieldName("argument"), locals);
  if (value.type === "call_expression") {
    const callee = value.childForFieldName("function");
    if (!callee) return null;
    // `std::make_unique<T>(…)`, `std::make_shared<T>(…)`.
    const template = callee.type === "template_function" ? callee : callee.type === "qualified_identifier" ? callee.childForFieldName("name") : null;
    if (template?.type === "template_function" && /^make_(?:unique|shared)$/u.test(nameParts(template).at(-1) ?? "")) {
      const argument = template.childForFieldName("arguments")?.namedChildren[0];
      const type = normalizeCppType(argument?.text);
      return type ? { type } : null;
    }
    if (callee.type === "identifier" || callee.type === "qualified_identifier") return { constructor: nameParts(callee).join("::") };
  }
  return null;
}
