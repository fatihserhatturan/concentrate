import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseSyntaxTreeSkippingErrors, type SyntaxNode } from "../syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../../../core/graph/model.js";
import type { LanguageParser } from "../../../core/contracts/language-parser.js";
import { callLikeTypes, createCallNode, createEnumConstantCall, hasCallSite, readLocals, type JavaLocals } from "./calls.js";
import {
  annotationOf,
  compact,
  javaParameters,
  modifiersOf,
  normalizeJavaType,
  typeDeclarationTypes,
  typeParametersOf,
  typeText,
  visibilityOf,
  type JavaAnnotation,
  type JavaParameter,
  type JavaVisibility,
} from "./syntax.js";

// Node types whose children are declarations or statements: one with a syntax
// error is left out on its own, and the rest of the file is kept.
const statementParents = new Set([
  "program",
  "class_body",
  "interface_body",
  "enum_body",
  "enum_body_declarations",
  "annotation_type_body",
  "block",
  "constructor_body",
  "switch_block",
  "switch_block_statement_group",
]);

type TypeKind = "class" | "interface" | "enum" | "record" | "annotation";
type Nesting = "top-level" | "static" | "inner" | "local" | "anonymous";

type Owner = {
  id: string;
  node: GraphNode;
  isInterface: boolean;
  kind: TypeKind;
  name: string;
  qualifiedName: string;
  // Name inside the package: `Outer.Inner`.
  relativeName: string;
  exported: boolean;
  anonymousCount: number;
  // Local classes seen so far by simple name: javac numbers them `Outer$1L`, `Outer$2L`.
  localCounts: Map<string, number>;
  staticInit: SyntaxNode[];
  instanceInit: SyntaxNode[];
  fields: Array<{ name: string; type: string | null; visibility: JavaVisibility; isStatic: boolean }>;
  methodNames: string[];
  hasEnumConstants: boolean;
};

const kindOfDeclaration: Record<string, TypeKind> = {
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  record_declaration: "record",
  annotation_type_declaration: "annotation",
};

// A method or constructor of the file with the syntax it was built from (`syntax` is its declaration).
export type JavaParsedFunction = { syntax: SyntaxNode; node: GraphNode };

// Parse-time semantics a framework layer adds to a Java file once its structure is built (the way
// Go's parse plugins do): it may add properties, nodes and relationships. It runs while the syntax
// tree is alive, so it can read what the graph does not keep (call arguments, nesting of calls).
export type JavaParsePlugin = (file: {
  fileNodeId: string;
  root: SyntaxNode;
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  functions: readonly JavaParsedFunction[];
}) => void;

// A plugin may carry a `version`: part of the parser's cache fingerprint, bumped when its output changes
// (so each framework layer bumps its own, not the parser's).
export type VersionedJavaParsePlugin = JavaParsePlugin & { version?: string };

export function createJavaParser(plugins: readonly VersionedJavaParsePlugin[] = []): LanguageParser {
  const versions = plugins.flatMap((plugin) => (plugin.version === undefined ? [] : [plugin.version]));
  return {
    language: "java",
    version: versions.length === 0 ? "1" : `1+${versions.join("+")}`,
    parse: (rootPath, filePath) => parseJavaFile(rootPath, filePath, plugins),
  };
}

export const javaParser: LanguageParser = createJavaParser();

async function parseJavaFile(rootPath: string, filePath: string, plugins: readonly JavaParsePlugin[]): Promise<ParsedSourceFile> {
  const source = await readFile(filePath, "utf8");
  const relativePath = path.relative(rootPath, filePath);
  const fileNodeId = `file:${relativePath}`;
  const fileNode: GraphNode = { id: fileNodeId, label: "File", properties: { path: filePath, relativePath, language: "java" } };
  const baseName = path.basename(filePath);
  if (baseName === "module-info.java") fileNode.properties.javaFileKind = "module-info";
  else if (baseName === "package-info.java") fileNode.properties.javaFileKind = "package-info";
  const nodes: GraphNode[] = [fileNode];
  const relationships: GraphRelationship[] = [];
  const usedIds = new Set<string>([fileNodeId]);
  const parsedFunctions: JavaParsedFunction[] = [];

  const { tree, skippedLines } = await parseSyntaxTreeSkippingErrors("java", source, statementParents, 4);
  try {
    let packageName = "";
    const uniqueId = (base: string, node: SyntaxNode) => {
      let id = base;
      if (usedIds.has(id)) id = `${base}:${node.startPosition.column}`;
      let n = 2;
      while (usedIds.has(id)) id = `${base}:${node.startPosition.column}:${n++}`;
      usedIds.add(id);
      return id;
    };
    const add = (node: GraphNode, from: string, type: string) => {
      nodes.push(node);
      relationships.push({ from, to: node.id, type: type as GraphRelationship["type"], properties: {} });
    };

    const addDecorators = (ownerId: string, relation: string, annotations: readonly SyntaxNode[]) => {
      for (const written of annotations) {
        const annotation: JavaAnnotation = annotationOf(written);
        add({
          id: uniqueId(`${ownerId}:decorator:${annotation.line}:${annotation.name}`, written),
          label: "Decorator",
          properties: { name: annotation.name, expression: annotation.expression, line: annotation.line, args: JSON.stringify(annotation.args) },
        }, ownerId, relation);
      }
    };

    const qualify = (scope: string, name: string) => (scope === "" ? name : `${scope}.${name}`);

    const supertypes = (node: SyntaxNode, field: string, wrapper?: string): Array<{ name: string; text: string }> => {
      const holder = wrapper
        ? node.namedChildren.find((child) => child.type === wrapper)
        : node.childForFieldName(field);
      if (!holder) return [];
      const list = holder.type === "type_list" ? holder : holder.namedChildren.find((child) => child.type === "type_list");
      const members = list ? list.namedChildren : holder.namedChildren;
      const result: Array<{ name: string; text: string }> = [];
      for (const member of members) {
        if (member.type.endsWith("comment")) continue;
        const name = normalizeJavaType(typeText(member));
        if (name) result.push({ name, text: typeText(member) });
      }
      return result;
    };

    const createOwner = (
      node: SyntaxNode,
      kind: TypeKind,
      name: string,
      outer: Owner | null,
      nesting: Nesting,
      words: ReadonlySet<string>,
      base: { extends: Array<{ name: string; text: string }>; implements: Array<{ name: string; text: string }> },
    ): Owner => {
      const isInterface = kind === "interface" || kind === "annotation";
      // An anonymous class `Outer$1` stands next to `Outer`, not under it.
      // A local class takes javac's binary name `Outer$1L`; the counter is per simple name.
      let suffix = `.${name}`;
      if (nesting === "anonymous") suffix = name.slice(name.lastIndexOf("$"));
      else if (nesting === "local" && outer) {
        const index = (outer.localCounts.get(name) ?? 0) + 1;
        outer.localCounts.set(name, index);
        suffix = `$${index}${name}`;
      }
      const qualifiedName = outer ? `${outer.qualifiedName}${suffix}` : qualify(packageName, name);
      const relativeName = outer ? `${outer.relativeName}${suffix}` : name;
      const line = node.startPosition.row + 1;
      const visibility = visibilityOf(words, outer?.isInterface ? "public" : "package");
      const exported = visibility !== "private" && nesting !== "local" && nesting !== "anonymous" && (outer?.exported ?? true);
      const typeParameters = typeParametersOf(node);
      const common = {
        name,
        line,
        endLine: node.endPosition.row + 1,
        isExported: exported,
        visibility,
        ...(typeParameters.length > 0 ? { typeParameters: JSON.stringify(typeParameters) } : {}),
        namespace: packageName,
        qualifiedName,
        outer: outer ? outer.qualifiedName : null,
        nesting,
      };
      const label = isInterface ? "Interface" : "Class";
      const id = uniqueId(`${fileNodeId}:${isInterface ? "interface" : "class"}:${line}:${qualifiedName}`, node);
      const properties: GraphNode["properties"] = isInterface
        ? {
          ...common,
          kind,
          methods: "[]",
          embeds: JSON.stringify(base.extends.map((type) => type.name)),
        }
        : {
          ...common,
          kind,
          isAbstract: words.has("abstract"),
          extendsNames: base.extends.length > 0 ? JSON.stringify(base.extends.map((type) => type.name)) : null,
          implementsNames: base.implements.length > 0 ? JSON.stringify(base.implements.map((type) => type.name)) : null,
          fields: "[]",
          bases: JSON.stringify([
            ...base.extends.map((type) => ({ name: type.name, text: type.text, relation: "extends" })),
            ...base.implements.map((type) => ({ name: type.name, text: type.text, relation: "implements" })),
          ]),
        };
      const ownerNode: GraphNode = { id, label, properties };
      add(ownerNode, fileNodeId, isInterface ? "DEFINES_INTERFACE" : "DEFINES_CLASS");
      return {
        id, node: ownerNode, isInterface, kind, name, qualifiedName, relativeName, exported,
        anonymousCount: 0, localCounts: new Map(), staticInit: [], instanceInit: [], fields: [], methodNames: [], hasEnumConstants: false,
      };
    };

    const handleType = (node: SyntaxNode, outer: Owner | null, nesting: Nesting): Owner | null => {
      const name = node.childForFieldName("name")?.text;
      const kind = kindOfDeclaration[node.type];
      if (!name || !kind) return null;
      const { words, annotations } = modifiersOf(node);
      const resolvedNesting: Nesting = nesting !== "top-level" ? nesting
        : outer === null ? "top-level"
        : outer.isInterface || kind !== "class" || words.has("static") ? "static" : "inner";
      const isInterface = kind === "interface" || kind === "annotation";
      const base = isInterface
        ? { extends: supertypes(node, "", "extends_interfaces"), implements: [] }
        : {
          extends: kind === "class" ? supertypes(node, "superclass") : [],
          implements: supertypes(node, "interfaces"),
        };
      const owner = createOwner(node, kind, name, outer, resolvedNesting, words, base);
      addDecorators(owner.id, isInterface ? "INTERFACE_HAS_DECORATOR" : "HAS_DECORATOR", annotations);
      handleBody(node, owner);
      return owner;
    };

    const handleAnonymous = (creation: SyntaxNode, body: SyntaxNode, enclosing: Owner, baseName: string | null): void => {
      enclosing.anonymousCount += 1;
      const name = `$${enclosing.anonymousCount}`;
      const owner = createOwner(creation, "class", `${enclosing.name}${name}`, enclosing, "anonymous", new Set(), {
        extends: baseName ? [{ name: baseName, text: baseName }] : [],
        implements: [],
      });
      handleMembers(body, owner);
      finish(owner);
    };

    // Walks code, adding its call sites to `fn` and the declarations it holds (local and anonymous classes).
    const walkCode = (roots: readonly SyntaxNode[], fn: GraphNode, owner: Owner, locals: JavaLocals): void => {
      const addCall = (call: GraphNode | null) => {
        if (!call) return;
        nodes.push(call);
        relationships.push({ from: fn.id, to: call.id, type: "CALLS", properties: {} });
      };
      // Iterative pre-order walk (a long `a + b + c ...` chain is a very deep tree). A step is
      // a node to visit or an action to run at that point of the order.
      type Step = SyntaxNode | (() => void);
      const walk = (root: SyntaxNode): void => {
        const stack: Step[] = [root];
        while (stack.length > 0) {
          const step = stack.pop()!;
          if (typeof step === "function") {
            step();
            continue;
          }
          const node = step;
          if (typeDeclarationTypes.has(node.type)) {
            const local = handleType(node, owner, "local");
            if (local) finish(local);
            continue;
          }
          if (node.type === "object_creation_expression") {
            addCall(createCallNode(fn.id, node, locals));
            const steps: Step[] = [];
            for (const child of node.namedChildren) {
              if (child.type === "class_body") steps.push(() => handleAnonymous(node, child, owner, normalizeJavaType(typeText(node.childForFieldName("type")))));
              else steps.push(child);
            }
            for (let i = steps.length - 1; i >= 0; i--) stack.push(steps[i]!);
            continue;
          }
          if (node.type === "enum_constant") {
            addCall(createEnumConstantCall(fn.id, node, owner.qualifiedName, locals));
            const steps: Step[] = [];
            for (const child of node.namedChildren) {
              if (child.type === "class_body") steps.push(() => handleAnonymous(node, child, owner, owner.qualifiedName));
              else if (child.type !== "identifier" && child.type !== "modifiers") steps.push(child);
            }
            for (let i = steps.length - 1; i >= 0; i--) stack.push(steps[i]!);
            continue;
          }
          if (callLikeTypes.has(node.type)) addCall(createCallNode(fn.id, node, locals));
          const children = node.namedChildren;
          for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
        }
      };
      for (const root of roots) walk(root);
    };

    const addFunction = (owner: Owner, spec: {
      node: SyntaxNode;
      name: string;
      kind: "method" | "constructor" | "initializer";
      methodKind: string | null;
      words: ReadonlySet<string>;
      annotations: readonly SyntaxNode[];
      parameters: JavaParameter[];
      returnType: string | null;
      visibility: JavaVisibility;
      isAbstract: boolean;
      isStatic: boolean;
      typeParameters: string[];
      roots: readonly SyntaxNode[];
    }): GraphNode => {
      const line = spec.node.startPosition.row + 1;
      const qualifiedName = `${owner.qualifiedName}.${spec.name}`;
      const locals = readLocals(spec.roots, spec.parameters);
      const fn: GraphNode = {
        id: uniqueId(`${fileNodeId}:function:${line}:${qualifiedName}`, spec.node),
        label: "Function",
        properties: {
          name: spec.name,
          kind: spec.kind,
          methodKind: spec.methodKind,
          line,
          endLine: spec.node.endPosition.row + 1,
          className: owner.relativeName,
          isExported: spec.visibility !== "private" && owner.exported && spec.kind !== "initializer",
          isAsync: false,
          isAbstract: spec.isAbstract,
          visibility: spec.visibility,
          parameters: JSON.stringify(spec.parameters),
          returnType: spec.returnType,
          ...(spec.typeParameters.length > 0 ? { typeParameters: JSON.stringify(spec.typeParameters) } : {}),
          namespace: packageName,
          qualifiedName,
          isStatic: spec.isStatic,
          parameterCount: spec.parameters.length,
          javaLocals: JSON.stringify(Object.fromEntries(locals)),
        },
      };
      add(fn, owner.id, owner.isInterface ? "DEFINES_INTERFACE_METHOD" : "DEFINES_METHOD");
      if (plugins.length > 0 && spec.kind !== "initializer") parsedFunctions.push({ syntax: spec.node, node: fn });
      addDecorators(fn.id, "HAS_METHOD_DECORATOR", spec.annotations);
      if (spec.kind !== "initializer") owner.methodNames.push(spec.name);
      walkCode(spec.roots, fn, owner, locals);
      // Call sites add the argument expressions of their calls to the locals.
      fn.properties.javaLocals = JSON.stringify(Object.fromEntries(locals));
      return fn;
    };

    const handleMethod = (member: SyntaxNode, owner: Owner): void => {
      const name = member.childForFieldName("name")?.text;
      if (!name) return;
      const { words, annotations } = modifiersOf(member);
      const body = member.childForFieldName("body");
      const isStatic = words.has("static");
      const visibility = visibilityOf(words, owner.isInterface ? "public" : "package");
      addFunction(owner, {
        node: member,
        name,
        kind: "method",
        methodKind: owner.isInterface && !body ? "interface-method" : words.has("default") ? "default-method" : null,
        words,
        annotations,
        parameters: javaParameters(member.childForFieldName("parameters")),
        returnType: typeText(member.childForFieldName("type")) || null,
        visibility,
        isAbstract: words.has("abstract") || (owner.isInterface && !body && !isStatic),
        isStatic,
        typeParameters: typeParametersOf(member),
        roots: body ? [body] : [],
      });
    };

    const handleConstructor = (member: SyntaxNode, owner: Owner): void => {
      const name = member.childForFieldName("name")?.text ?? owner.name;
      const { words, annotations } = modifiersOf(member);
      const compactForm = member.type === "compact_constructor_declaration";
      const parameters = compactForm
        ? recordComponents(owner)
        : javaParameters(member.childForFieldName("parameters"));
      addFunction(owner, {
        node: member,
        name,
        kind: "constructor",
        methodKind: compactForm ? "compact" : null,
        words,
        annotations,
        parameters,
        returnType: null,
        visibility: visibilityOf(words, owner.kind === "enum" ? "private" : "package"),
        isAbstract: false,
        isStatic: false,
        typeParameters: typeParametersOf(member),
        roots: [member.childForFieldName("body")].filter((body): body is SyntaxNode => body !== null),
      });
    };

    const recordComponentList = new WeakMap<GraphNode, JavaParameter[]>();
    const recordComponents = (owner: Owner) => recordComponentList.get(owner.node) ?? [];

    const addField = (owner: Owner, spec: {
      node: SyntaxNode;
      name: string;
      declaredType: string;
      normalized: string | null;
      visibility: JavaVisibility;
      isStatic: boolean;
      isFinal: boolean;
      fieldKind: string;
      annotations: readonly SyntaxNode[];
    }): void => {
      const field: GraphNode = {
        id: uniqueId(`${owner.id}:field:${spec.name}`, spec.node),
        label: "Field",
        properties: {
          name: spec.name,
          typeName: spec.normalized,
          isStatic: spec.isStatic,
          isReadonly: spec.isFinal,
          visibility: spec.visibility,
          line: spec.node.startPosition.row + 1,
          declaredType: spec.declaredType,
          fieldKind: spec.fieldKind,
        },
      };
      add(field, owner.id, owner.isInterface ? "DEFINES_INTERFACE_FIELD" : "DEFINES_FIELD");
      addDecorators(field.id, "FIELD_HAS_DECORATOR", spec.annotations);
      owner.fields.push({ name: spec.name, type: spec.normalized, visibility: spec.visibility, isStatic: spec.isStatic });
    };

    const handleField = (member: SyntaxNode, owner: Owner): void => {
      const { words, annotations } = modifiersOf(member);
      const typeNode = member.childForFieldName("type");
      const isConstant = member.type === "constant_declaration" || owner.isInterface;
      const isStatic = isConstant || words.has("static");
      for (const declarator of member.childrenForFieldName("declarator")) {
        const name = declarator.childForFieldName("name")?.text;
        if (!name) continue;
        const dimensions = declarator.childForFieldName("dimensions")?.text.replace(/\s+/gu, "") ?? "";
        const declaredType = `${typeText(typeNode)}${dimensions}`;
        addField(owner, {
          node: declarator,
          name,
          declaredType,
          normalized: normalizeJavaType(declaredType),
          visibility: visibilityOf(words, owner.isInterface ? "public" : "package"),
          isStatic,
          isFinal: isConstant || words.has("final"),
          fieldKind: isConstant ? "constant" : "field",
          annotations,
        });
        const value = declarator.childForFieldName("value");
        if (value) (isStatic ? owner.staticInit : owner.instanceInit).push(value);
      }
    };

    const handleMembers = (body: SyntaxNode, owner: Owner): void => {
      for (const member of body.namedChildren) {
        switch (member.type) {
          case "field_declaration":
          case "constant_declaration":
            handleField(member, owner);
            break;
          case "method_declaration":
            handleMethod(member, owner);
            break;
          case "annotation_type_element_declaration": {
            const name = member.childForFieldName("name")?.text;
            if (!name) break;
            const { annotations } = modifiersOf(member);
            addFunction(owner, {
              node: member, name, kind: "method", methodKind: "interface-method", words: new Set(), annotations, parameters: [],
              returnType: typeText(member.childForFieldName("type")) || null, visibility: "public", isAbstract: true, isStatic: false, typeParameters: [], roots: [],
            });
            break;
          }
          case "constructor_declaration":
          case "compact_constructor_declaration":
            handleConstructor(member, owner);
            break;
          case "static_initializer":
            owner.staticInit.push(member);
            break;
          case "block":
            owner.instanceInit.push(member);
            break;
          case "enum_constant": {
            const name = member.childForFieldName("name")?.text;
            if (!name) break;
            owner.hasEnumConstants = true;
            addField(owner, {
              node: member, name, declaredType: owner.qualifiedName, normalized: owner.qualifiedName, visibility: "public", isStatic: true, isFinal: true,
              fieldKind: "enum-constant", annotations: modifiersOf(member).annotations,
            });
            owner.staticInit.push(member);
            break;
          }
          case "enum_body_declarations":
            handleMembers(member, owner);
            break;
          default:
            if (typeDeclarationTypes.has(member.type)) handleType(member, owner, "top-level");
        }
      }
    };

    const handleBody = (node: SyntaxNode, owner: Owner): void => {
      if (owner.kind === "record") {
        const components = javaParameters(node.childForFieldName("parameters"));
        recordComponentList.set(owner.node, components);
        for (const component of components) {
          addField(owner, {
            node, name: component.name, declaredType: component.type, normalized: normalizeJavaType(component.type), visibility: "private",
            isStatic: false, isFinal: true, fieldKind: "record-component", annotations: [],
          });
        }
      }
      const body = node.childForFieldName("body");
      if (body) handleMembers(body, owner);
      finish(owner);
    };

    // Field initializers and initializer blocks hold call sites too: they belong to a synthetic
    // function per class (`<clinit>` for static ones, `<init-block>` for instance ones).
    const flushInitializer = (owner: Owner, items: SyntaxNode[], isStatic: boolean): void => {
      if (items.length === 0 || !items.some((item) => hasCallSite(item))) return;
      const name = isStatic ? "<clinit>" : "<init-block>";
      const node = items[0]!;
      const line = node.startPosition.row + 1;
      const locals = readLocals(items, []);
      const fn: GraphNode = {
        id: uniqueId(`${fileNodeId}:function:${line}:${owner.qualifiedName}.${name}`, node),
        label: "Function",
        properties: {
          name,
          kind: "initializer",
          methodKind: isStatic ? "static-initializer" : "instance-initializer",
          line,
          endLine: items.at(-1)!.endPosition.row + 1,
          className: owner.relativeName,
          isExported: false,
          isAsync: false,
          isAbstract: false,
          visibility: "private",
          parameters: "[]",
          returnType: null,
          namespace: packageName,
          qualifiedName: `${owner.qualifiedName}.${name}`,
          isStatic,
          parameterCount: 0,
          javaLocals: JSON.stringify(Object.fromEntries(locals)),
        },
      };
      add(fn, owner.id, owner.isInterface ? "DEFINES_INTERFACE_METHOD" : "DEFINES_METHOD");
      walkCode(items, fn, owner, locals);
      fn.properties.javaLocals = JSON.stringify(Object.fromEntries(locals));
    };

    const finishedOwners = new WeakSet<GraphNode>();
    const finish = (owner: Owner): void => {
      if (finishedOwners.has(owner.node)) return;
      finishedOwners.add(owner.node);
      flushInitializer(owner, owner.staticInit, true);
      flushInitializer(owner, owner.instanceInit, false);
      if (owner.isInterface) owner.node.properties.methods = JSON.stringify(owner.methodNames);
      else owner.node.properties.fields = JSON.stringify(owner.fields);
    };

    // Top level: package, imports, types.
    for (const child of tree.rootNode.namedChildren) {
      switch (child.type) {
        case "package_declaration": {
          const name = child.namedChildren.find((candidate) => candidate.type === "scoped_identifier" || candidate.type === "identifier");
          if (name) {
            packageName = name.text.replace(/\s+/gu, "");
            fileNode.properties.packageName = packageName;
          }
          break;
        }
        case "import_declaration": {
          const name = child.namedChildren.find((candidate) => candidate.type === "scoped_identifier" || candidate.type === "identifier");
          if (!name) break;
          const source = name.text.replace(/\s+/gu, "");
          const line = child.startPosition.row + 1;
          add({
            id: `${fileNodeId}:import:${line}:${source}`,
            label: "Import",
            properties: {
              source,
              specifier: compact(child.text),
              line,
              isWildcard: child.namedChildren.some((candidate) => candidate.type === "asterisk"),
              isStatic: child.children.some((candidate) => candidate.type === "static"),
            },
          }, fileNodeId, "IMPORTS");
          break;
        }
        case "module_declaration": {
          const name = child.namedChildren.find((candidate) => candidate.type === "scoped_identifier" || candidate.type === "identifier");
          if (name) fileNode.properties.javaModule = name.text.replace(/\s+/gu, "");
          break;
        }
        default:
          if (typeDeclarationTypes.has(child.type)) handleType(child, null, "top-level");
      }
    }

    for (const plugin of plugins) plugin({ fileNodeId, root: tree.rootNode, nodes, relationships, functions: parsedFunctions });

    const parsed: ParsedSourceFile = { fileNodeId, nodes, relationships };
    if (skippedLines.length > 0) {
      parsed.warnings = [`Syntax error: left out the statement${skippedLines.length === 1 ? "" : "s"} at line${skippedLines.length === 1 ? "" : "s"} ${skippedLines.join(", ")}`];
    }
    return parsed;
  } finally {
    tree.delete();
  }
}
