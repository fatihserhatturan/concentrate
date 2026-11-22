import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseSyntaxTreeSkippingErrors, type SyntaxNode } from "../syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../../../core/graph/model.js";
import type { LanguageParser } from "../../../core/contracts/language-parser.js";
import { callLikeTypes, createCallNode, declaratorValue, hasCallSite, readLocals, type CSharpLocals } from "./calls.js";
import {
  attributesOf,
  compact,
  compactNoSpace,
  constraintsOf,
  csharpParameters,
  isComment,
  modifiersOf,
  nameText,
  plainName,
  trailingArity,
  normalizeCSharpType,
  dottedName,
  typeDeclarationTypes,
  typeParametersOf,
  typeText,
  visibilityOf,
  type CSharpAttribute,
  type CSharpConstraint,
  type CSharpParameter,
  type CSharpVisibility,
} from "./syntax.js";

// Node types whose children are declarations or statements: one with a syntax error is left out on its own,
// and the rest of the file is kept.
const statementParents = new Set([
  "compilation_unit",
  "declaration_list",
  "enum_member_declaration_list",
  "block",
  "switch_section",
]);

type TypeKind = "class" | "struct" | "interface" | "record" | "record struct" | "enum" | "delegate";
type Nesting = "top-level" | "nested";

type FieldFact = { name: string; type: string | null; visibility: CSharpVisibility; isStatic: boolean };

// What one declaration of a type says, kept per file (a `partial` type has several; the graph keeps the first node).
type PartialFact = {
  id: string;
  name: string;
  qualifiedName: string;
  partialKey: string;
  kind: TypeKind;
  line: number;
  endLine: number;
  visibility: CSharpVisibility;
  modifiers: string[];
  typeParameters: string[];
  constraints: CSharpConstraint[];
  bases: Array<{ name: string; text: string; relation: string }>;
  namespace: string;
  nesting: Nesting;
  outer: string | null;
  fields: FieldFact[];
  methods: string[];
};

type Owner = {
  id: string;
  node: GraphNode;
  isInterface: boolean;
  kind: TypeKind;
  name: string;
  namespace: string;
  qualifiedName: string;
  // Name inside the namespace: `Outer.Inner`.
  relativeName: string;
  // `qualifiedName` with generic arities (`Ns.Outer`1.Inner`): what `partial` declarations of the type share.
  keyName: string;
  exported: boolean;
  staticInit: SyntaxNode[];
  instanceInit: SyntaxNode[];
  fields: FieldFact[];
  methodNames: string[];
  fact: PartialFact;
};

const kindOfDeclaration: Record<string, TypeKind> = {
  class_declaration: "class",
  struct_declaration: "struct",
  interface_declaration: "interface",
  record_declaration: "record",
  record_struct_declaration: "record struct",
  enum_declaration: "enum",
  delegate_declaration: "delegate",
};

const qualify = (scope: string, name: string) => (scope === "" ? name : `${scope}.${name}`);

// A method, constructor, accessor or operator of the file with the syntax it was built from (`syntax` is its
// declaration; for a primary constructor the parameter list). The synthetic `<top-level>` function of a file with
// top-level statements is listed with `syntax` the compilation unit.
export type CSharpParsedFunction = { syntax: SyntaxNode; node: GraphNode };
// A type declaration (class, struct, record, interface, enum, delegate) with its Class or Interface node. A `partial`
// type has one node for every declaring file: each file lists it with its own syntax.
export type CSharpParsedType = { syntax: SyntaxNode; node: GraphNode };
// An invocation or object creation with its Call node and the Function whose body holds it.
export type CSharpParsedCall = { syntax: SyntaxNode; node: GraphNode; function: GraphNode };

// Parse-time semantics a framework layer adds to a C# file once its structure is built (the way Java and Go
// parse plugins do): it may add properties, nodes and relationships. It runs while the syntax tree is alive, so it
// can read what the graph does not keep (lambda bodies, argument expressions, nesting of calls).
export type CSharpParsePlugin = (file: {
  fileNodeId: string;
  root: SyntaxNode;
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  functions: readonly CSharpParsedFunction[];
  types: readonly CSharpParsedType[];
  calls: readonly CSharpParsedCall[];
}) => void;

// A plugin may carry a `version`: part of the parser's cache fingerprint, bumped when its output changes
// (so each framework layer bumps its own, not the parser's).
export type VersionedCSharpParsePlugin = CSharpParsePlugin & { version?: string };

export function createCSharpParser(plugins: readonly VersionedCSharpParsePlugin[] = []): LanguageParser {
  const versions = plugins.flatMap((plugin) => (plugin.version === undefined ? [] : [plugin.version]));
  return {
    language: "csharp",
    version: versions.length === 0 ? "1" : `1+${versions.join("+")}`,
    parse: (rootPath, filePath) => parseCSharpFile(rootPath, filePath, plugins),
  };
}

export const csharpParser: LanguageParser = createCSharpParser();

async function parseCSharpFile(rootPath: string, filePath: string, plugins: readonly CSharpParsePlugin[]): Promise<ParsedSourceFile> {
  const source = await readFile(filePath, "utf8");
  const relativePath = path.relative(rootPath, filePath);
  const fileNodeId = `file:${relativePath}`;
  const fileNode: GraphNode = { id: fileNodeId, label: "File", properties: { path: filePath, relativePath, language: "csharp" } };
  const nodes: GraphNode[] = [fileNode];
  const relationships: GraphRelationship[] = [];
  const usedIds = new Set<string>([fileNodeId]);
  const namespaces = new Set<string>();
  const partialFacts: PartialFact[] = [];
  const parsedFunctions: CSharpParsedFunction[] = [];
  const parsedTypes: CSharpParsedType[] = [];
  const parsedCalls: CSharpParsedCall[] = [];

  const { tree, skippedLines } = await parseSyntaxTreeSkippingErrors("csharp", source, statementParents, 4);
  try {
    const uniqueId = (base: string, node: { startPosition: { column: number } }) => {
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

    // Decorator ids carry the file: the owner of a `partial` type has one id in every file.
    const addDecorators = (ownerId: string, relation: string, attributes: readonly CSharpAttribute[], defaultTarget: string | null = null) => {
      for (const attribute of attributes) {
        const id = uniqueId(`${fileNodeId}:decorator:${attribute.line}:${attribute.name}`, { startPosition: { column: attribute.column } });
        const target = attribute.target ?? defaultTarget;
        add({
          id,
          label: "Decorator",
          properties: {
            name: attribute.name,
            expression: attribute.expression,
            line: attribute.line,
            args: JSON.stringify(attribute.args),
            ...(target ? { attributeTarget: target } : {}),
          },
        }, ownerId, relation);
      }
    };

    // The types of a base list in order (`: Base(args), IFoo<T>`): name without generic arguments, and the text as written.
    const baseListOf = (node: SyntaxNode, kind: TypeKind): { bases: Array<{ name: string; text: string; relation: string }>; argumentLists: SyntaxNode[] } => {
      const list = node.namedChildren.find((child) => child.type === "base_list");
      const bases: Array<{ name: string; text: string; relation: string }> = [];
      const argumentLists: SyntaxNode[] = [];
      for (const member of list?.namedChildren ?? []) {
        if (isComment(member)) continue;
        if (member.type === "argument_list") {
          argumentLists.push(member);
          continue;
        }
        const typeNode = member.type === "primary_constructor_base_type" ? member.namedChildren.find((child) => child.type !== "argument_list" && !isComment(child)) ?? member : member;
        if (member.type === "primary_constructor_base_type") for (const child of member.namedChildren) if (child.type === "argument_list") argumentLists.push(child);
        const name = normalizeCSharpType(typeText(typeNode));
        if (!name) continue;
        // `base`: the first entry of a class or record list, a class or an interface (resolution decides);
        // `interface`: an interface; `underlying`: the integral type of an enum.
        const relation = kind === "enum" ? "underlying" : (kind === "class" || kind === "record") && bases.length === 0 ? "base" : "interface";
        bases.push({ name, text: typeText(typeNode), relation });
      }
      return { bases, argumentLists };
    };

    const createOwner = (
      node: SyntaxNode,
      kind: TypeKind,
      name: string,
      outer: Owner | null,
      namespace: string,
      words: ReadonlySet<string>,
    ): Owner => {
      const isInterface = kind === "interface";
      const qualifiedName = outer ? `${outer.qualifiedName}.${name}` : qualify(namespace, name);
      const relativeName = outer ? `${outer.relativeName}.${name}` : name;
      const typeParameters = typeParametersOf(node);
      const arity = typeParameters.length;
      const keyPart = `${name}${arity > 0 ? `\`${arity}` : ""}`;
      const keyName = outer ? `${outer.keyName}.${keyPart}` : qualify(namespace, keyPart);
      const isPartial = words.has("partial");
      const line = node.startPosition.row + 1;
      const visibility = visibilityOf(words, outer ? "private" : "internal");
      const exported = visibility !== "private" && visibility !== "file" && (outer?.exported ?? true);
      const constraints = constraintsOf(node);
      const { bases } = baseListOf(node, kind);
      const nesting: Nesting = outer ? "nested" : "top-level";
      const common = {
        name,
        line,
        endLine: node.endPosition.row + 1,
        isExported: exported,
        visibility,
        ...(arity > 0 ? { typeParameters: JSON.stringify(typeParameters) } : {}),
        namespace,
        qualifiedName,
        outer: outer ? outer.qualifiedName : null,
        nesting,
        arity,
        ...(isPartial ? { isPartial: true, partialKey: keyName } : {}),
        ...(constraints.length > 0 ? { constraints: JSON.stringify(constraints) } : {}),
        ...(bases.length > 0 ? { baseNames: JSON.stringify(bases.map((base) => base.name)), bases: JSON.stringify(bases) } : {}),
      };
      const label = isInterface ? "Interface" : "Class";
      // A `partial` type has one node for all its declarations: the id comes from the namespace-qualified name.
      const id = isPartial ? `csharp:partial:${keyName}` : uniqueId(`${fileNodeId}:${isInterface ? "interface" : "class"}:${line}:${qualifiedName}`, node);
      const properties: GraphNode["properties"] = isInterface
        ? { ...common, kind, methods: "[]", embeds: JSON.stringify(bases.map((base) => base.name)) }
        : {
          ...common,
          kind,
          isAbstract: words.has("abstract"),
          isStatic: words.has("static"),
          isSealed: words.has("sealed"),
          fields: "[]",
        };
      const ownerNode: GraphNode = { id, label, properties };
      add(ownerNode, fileNodeId, isInterface ? "DEFINES_INTERFACE" : "DEFINES_CLASS");
      const fact: PartialFact = {
        id, name, qualifiedName, partialKey: keyName, kind, line, endLine: node.endPosition.row + 1, visibility, modifiers: [...words],
        typeParameters, constraints, bases, namespace, nesting, outer: outer ? outer.qualifiedName : null, fields: [], methods: [],
      };
      if (isPartial) partialFacts.push(fact);
      return {
        id, node: ownerNode, isInterface, kind, name, namespace, qualifiedName, relativeName, keyName, exported,
        staticInit: [], instanceInit: [], fields: [], methodNames: [], fact,
      };
    };

    // Walks code, adding its call sites to `fn`.
    const walkCode = (roots: readonly SyntaxNode[], fn: GraphNode, locals: CSharpLocals): void => {
      // Iterative pre-order walk (a long `a + b + c ...` chain is a very deep tree).
      const stack: SyntaxNode[] = [];
      for (let r = roots.length - 1; r >= 0; r--) stack.push(roots[r]!);
      while (stack.length > 0) {
        const node = stack.pop()!;
        if (callLikeTypes.has(node.type)) {
          const call = createCallNode(fn.id, node, locals);
          if (call) {
            nodes.push(call);
            relationships.push({ from: fn.id, to: call.id, type: "CALLS", properties: {} });
            if (plugins.length > 0) parsedCalls.push({ syntax: node, node: call, function: fn });
          }
        }
        const children = node.namedChildren;
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
      }
    };

    type FunctionSpec = {
      node: SyntaxNode;
      name: string;
      kind: "method" | "constructor" | "destructor" | "operator" | "accessor" | "initializer";
      methodKind: string | null;
      words: ReadonlySet<string>;
      attributes: readonly CSharpAttribute[];
      parameters: CSharpParameter[];
      returnType: string | null;
      visibility: CSharpVisibility;
      isAbstract: boolean;
      isStatic: boolean;
      typeParameters: string[];
      constraints?: CSharpConstraint[];
      explicitInterface?: string | null;
      hasBody?: boolean;
      roots: readonly SyntaxNode[];
    };

    const addFunction = (owner: Owner, spec: FunctionSpec): GraphNode => {
      const line = spec.node.startPosition.row + 1;
      const qualifiedName = `${owner.qualifiedName}.${spec.name}`;
      const locals = readLocals(spec.roots, spec.parameters);
      const first = spec.parameters[0];
      const isExtension = spec.kind === "method" && spec.isStatic && first?.modifier !== undefined && first.modifier.split(" ").includes("this");
      const hasParams = spec.parameters.some((parameter) => parameter.params === true);
      const required = spec.parameters.filter((parameter) => parameter.optional !== true && parameter.params !== true).length;
      const properties: GraphNode["properties"] = {
        name: spec.name,
        kind: spec.kind,
        methodKind: spec.methodKind,
        line,
        endLine: spec.node.endPosition.row + 1,
        className: owner.relativeName,
        isExported: spec.visibility !== "private" && spec.visibility !== "file" && owner.exported && spec.kind !== "initializer",
        isAsync: spec.words.has("async"),
        isAbstract: spec.isAbstract,
        visibility: spec.visibility,
        parameters: JSON.stringify(spec.parameters),
        returnType: spec.returnType,
        ...(spec.typeParameters.length > 0 ? { typeParameters: JSON.stringify(spec.typeParameters) } : {}),
        namespace: owner.namespace,
        qualifiedName,
        isStatic: spec.isStatic,
        parameterCount: spec.parameters.length,
        requiredParameterCount: required,
        ...(hasParams ? { hasParams: true } : {}),
        isVirtual: spec.words.has("virtual"),
        isOverride: spec.words.has("override"),
        isSealed: spec.words.has("sealed"),
        ...(spec.words.has("partial") ? { isPartial: true, ...(spec.hasBody === undefined ? {} : { hasBody: spec.hasBody }) } : {}),
        ...(isExtension ? { isExtension: true, extensionReceiver: normalizeCSharpType(first!.type) } : {}),
        ...(spec.explicitInterface ? { explicitInterface: spec.explicitInterface } : {}),
        ...(spec.constraints && spec.constraints.length > 0 ? { constraints: JSON.stringify(spec.constraints) } : {}),
        csharpLocals: JSON.stringify(Object.fromEntries(locals)),
      };
      const fn: GraphNode = { id: uniqueId(`${fileNodeId}:function:${line}:${qualifiedName}`, spec.node), label: "Function", properties };
      add(fn, owner.id, owner.isInterface ? "DEFINES_INTERFACE_METHOD" : "DEFINES_METHOD");
      addDecorators(fn.id, "HAS_METHOD_DECORATOR", spec.attributes);
      if (spec.kind !== "initializer") {
        owner.methodNames.push(spec.name);
        owner.fact.methods.push(spec.name);
      }
      if (plugins.length > 0 && spec.kind !== "initializer") parsedFunctions.push({ syntax: spec.node, node: fn });
      walkCode(spec.roots, fn, locals);
      return fn;
    };

    const explicitInterfaceOf = (member: SyntaxNode): string | null => {
      const specifier = member.namedChildren.find((child) => child.type === "explicit_interface_specifier");
      const type = specifier?.namedChildren.find((child) => !isComment(child));
      return type ? normalizeCSharpType(typeText(type)) ?? compactNoSpace(type.text) : null;
    };

    const bodyRoots = (node: SyntaxNode): SyntaxNode[] => {
      const body = node.childForFieldName("body");
      return body ? [body] : [];
    };

    const handleMethod = (member: SyntaxNode, owner: Owner): void => {
      const name = nameText(member.childForFieldName("name"));
      if (!name) return;
      const { words, attributeLists } = modifiersOf(member);
      const body = member.childForFieldName("body");
      const explicitInterface = explicitInterfaceOf(member);
      const isStatic = words.has("static");
      addFunction(owner, {
        node: member,
        name,
        kind: "method",
        methodKind: owner.isInterface && !body ? "interface-method" : null,
        words,
        attributes: attributesOf(attributeLists),
        parameters: csharpParameters(member.childForFieldName("parameters")),
        returnType: typeText(member.childForFieldName("returns")) || null,
        visibility: explicitInterface ? "private" : visibilityOf(words, owner.isInterface ? "public" : "private"),
        isAbstract: words.has("abstract") || (owner.isInterface && !body && !isStatic && !words.has("sealed")),
        isStatic,
        typeParameters: typeParametersOf(member),
        constraints: constraintsOf(member),
        explicitInterface,
        hasBody: body !== null,
        roots: body ? [body] : [],
      });
    };

    const handleConstructor = (member: SyntaxNode, owner: Owner): void => {
      const { words, attributeLists } = modifiersOf(member);
      const isStatic = words.has("static");
      const initializer = member.namedChildren.find((child) => child.type === "constructor_initializer");
      addFunction(owner, {
        node: member,
        name: owner.name,
        kind: "constructor",
        methodKind: isStatic ? "static" : null,
        words,
        attributes: attributesOf(attributeLists),
        parameters: csharpParameters(member.childForFieldName("parameters")),
        returnType: null,
        visibility: isStatic ? "private" : visibilityOf(words, "private"),
        isAbstract: false,
        isStatic,
        typeParameters: [],
        roots: [...(initializer ? [initializer] : []), ...bodyRoots(member)],
      });
    };

    const handleDestructor = (member: SyntaxNode, owner: Owner): void => {
      const { words, attributeLists } = modifiersOf(member);
      addFunction(owner, {
        node: member, name: `~${owner.name}`, kind: "destructor", methodKind: null, words, attributes: attributesOf(attributeLists), parameters: [],
        returnType: null, visibility: "private", isAbstract: false, isStatic: false, typeParameters: [], roots: bodyRoots(member),
      });
    };

    const handleOperator = (member: SyntaxNode, owner: Owner): void => {
      const { words, attributeLists } = modifiersOf(member);
      let name: string;
      if (member.type === "conversion_operator_declaration") {
        const direction = member.children.find((child) => child.type === "implicit" || child.type === "explicit")?.type ?? "implicit";
        name = `${direction} operator ${typeText(member.childForFieldName("type"))}`;
      } else {
        const operatorToken = member.childForFieldName("operator");
        name = `operator${operatorToken ? operatorToken.text : ""}`;
      }
      addFunction(owner, {
        node: member, name, kind: "operator", methodKind: member.type === "conversion_operator_declaration" ? "conversion" : null, words,
        attributes: attributesOf(attributeLists), parameters: csharpParameters(member.childForFieldName("parameters")),
        returnType: typeText(member.childForFieldName("type")) || null, visibility: visibilityOf(words, "private"), isAbstract: words.has("abstract"),
        isStatic: true, typeParameters: [], roots: bodyRoots(member),
      });
    };

    const addField = (owner: Owner, spec: {
      node: SyntaxNode;
      name: string;
      declaredType: string;
      visibility: CSharpVisibility;
      isStatic: boolean;
      isReadonly: boolean;
      fieldKind: string;
      attributes: readonly CSharpAttribute[];
      extra?: Record<string, string | number | boolean | null>;
    }): GraphNode => {
      const normalized = normalizeCSharpType(spec.declaredType);
      const line = spec.node.startPosition.row + 1;
      const field: GraphNode = {
        id: uniqueId(`${fileNodeId}:field:${line}:${owner.qualifiedName}.${spec.name}`, spec.node),
        label: "Field",
        properties: {
          name: spec.name,
          typeName: normalized,
          isStatic: spec.isStatic,
          isReadonly: spec.isReadonly,
          visibility: spec.visibility,
          line,
          declaredType: spec.declaredType,
          fieldKind: spec.fieldKind,
          ...spec.extra,
        },
      };
      add(field, owner.id, owner.isInterface ? "DEFINES_INTERFACE_FIELD" : "DEFINES_FIELD");
      addDecorators(field.id, "FIELD_HAS_DECORATOR", spec.attributes);
      const fact: FieldFact = { name: spec.name, type: normalized, visibility: spec.visibility, isStatic: spec.isStatic };
      owner.fields.push(fact);
      owner.fact.fields.push(fact);
      return field;
    };

    const handleField = (member: SyntaxNode, owner: Owner): void => {
      const { words, attributeLists } = modifiersOf(member);
      const declaration = member.namedChildren.find((child) => child.type === "variable_declaration");
      if (!declaration) return;
      const isEvent = member.type === "event_field_declaration";
      const isConstant = words.has("const");
      const isStatic = isConstant || words.has("static");
      const attributes = attributesOf(attributeLists);
      const declaredType = typeText(declaration.childForFieldName("type"));
      for (const declarator of declaration.namedChildren.filter((child) => child.type === "variable_declarator")) {
        const name = nameText(declarator.childForFieldName("name"));
        if (!name) continue;
        addField(owner, {
          node: declarator,
          name,
          declaredType,
          visibility: visibilityOf(words, owner.isInterface ? "public" : "private"),
          isStatic,
          isReadonly: isConstant || words.has("readonly"),
          fieldKind: isEvent ? "event" : isConstant ? "constant" : "field",
          attributes,
          extra: isEvent ? { isAbstract: words.has("abstract"), isVirtual: words.has("virtual"), isOverride: words.has("override") } : {},
        });
        const value = declaratorValue(declarator);
        if (value) (isStatic ? owner.staticInit : owner.instanceInit).push(value);
      }
    };

    // Accessors with a body (`get { ... }`, `set => ...`, `add`, `remove`) are functions `get_Name`, `set_Name`, ...
    const addAccessors = (owner: Owner, member: SyntaxNode, memberName: string, kind: string, words: ReadonlySet<string>, visibility: CSharpVisibility, parameters: CSharpParameter[], returnType: string | null): void => {
      const list = member.childForFieldName("accessors");
      const arrow = member.childForFieldName("value")?.type === "arrow_expression_clause" ? member.childForFieldName("value") : null;
      const declared: Array<{ accessor: string; node: SyntaxNode; roots: SyntaxNode[]; words: ReadonlySet<string>; attributes: CSharpAttribute[] }> = [];
      if (arrow) declared.push({ accessor: "get", node: arrow, roots: [arrow], words, attributes: [] });
      for (const accessor of list?.namedChildren ?? []) {
        if (accessor.type !== "accessor_declaration") continue;
        const accessorName = nameText(accessor.childForFieldName("name"));
        const body = accessor.childForFieldName("body");
        if (!accessorName || !body) continue;
        const own = modifiersOf(accessor);
        declared.push({ accessor: accessorName, node: accessor, roots: [body], words: own.words, attributes: attributesOf(own.attributeLists) });
      }
      for (const entry of declared) {
        // An accessor may narrow the member's visibility (`public int X { get; private set; }`) and inherits its other modifiers.
        const inherited = [...words].filter((word) => word === "static" || word === "override" || word === "virtual" || word === "sealed" || word === "async");
        addFunction(owner, {
          node: entry.node,
          name: `${entry.accessor}_${memberName}`,
          kind: "accessor",
          methodKind: `${kind}-${entry.accessor}`,
          words: new Set([...entry.words, ...inherited]),
          attributes: entry.attributes,
          parameters: entry.accessor === "get" ? parameters : [...parameters, { name: "value", type: returnType ?? "" }],
          returnType: entry.accessor === "get" ? returnType : null,
          visibility: visibilityOf(entry.words, visibility),
          isAbstract: false,
          isStatic: words.has("static"),
          typeParameters: [],
          roots: entry.roots,
        });
      }
    };

    const accessorNames = (member: SyntaxNode): string => {
      const names: string[] = [];
      for (const accessor of member.childForFieldName("accessors")?.namedChildren ?? []) {
        if (accessor.type === "accessor_declaration") {
          const name = nameText(accessor.childForFieldName("name"));
          if (name) names.push(name);
        }
      }
      if (names.length === 0 && member.childForFieldName("value")?.type === "arrow_expression_clause") names.push("get");
      return names.join(",");
    };

    const handleProperty = (member: SyntaxNode, owner: Owner): void => {
      const name = nameText(member.childForFieldName("name"));
      if (!name) return;
      const { words, attributeLists } = modifiersOf(member);
      const explicitInterface = explicitInterfaceOf(member);
      const declaredType = typeText(member.childForFieldName("type"));
      const accessors = accessorNames(member);
      const hasBody = (member.childForFieldName("accessors")?.namedChildren ?? []).some((accessor) => accessor.childForFieldName("body") !== null)
        || member.childForFieldName("value")?.type === "arrow_expression_clause";
      const visibility: CSharpVisibility = explicitInterface ? "private" : visibilityOf(words, owner.isInterface ? "public" : "private");
      const isStatic = words.has("static");
      addField(owner, {
        node: member,
        name,
        declaredType,
        visibility,
        isStatic,
        isReadonly: !accessors.split(",").some((accessor) => accessor === "set"),
        fieldKind: "property",
        attributes: attributesOf(attributeLists),
        extra: {
          isAbstract: words.has("abstract") || (owner.isInterface && !hasBody && !isStatic),
          isVirtual: words.has("virtual"),
          isOverride: words.has("override"),
          accessors,
          ...(explicitInterface ? { explicitInterface } : {}),
        },
      });
      const value = member.childForFieldName("value");
      if (value && value.type !== "arrow_expression_clause") (isStatic ? owner.staticInit : owner.instanceInit).push(value);
      addAccessors(owner, member, name, "property", words, visibility, [], declaredType || null);
    };

    const handleIndexer = (member: SyntaxNode, owner: Owner): void => {
      const { words, attributeLists } = modifiersOf(member);
      const explicitInterface = explicitInterfaceOf(member);
      const declaredType = typeText(member.childForFieldName("type"));
      const parameters = csharpParameters(member.childForFieldName("parameters"));
      const accessors = accessorNames(member);
      const hasBody = (member.childForFieldName("accessors")?.namedChildren ?? []).some((accessor) => accessor.childForFieldName("body") !== null)
        || member.childForFieldName("value")?.type === "arrow_expression_clause";
      const visibility: CSharpVisibility = explicitInterface ? "private" : visibilityOf(words, owner.isInterface ? "public" : "private");
      addField(owner, {
        node: member,
        name: "this[]",
        declaredType,
        visibility,
        isStatic: false,
        isReadonly: !accessors.split(",").some((accessor) => accessor === "set"),
        fieldKind: "indexer",
        attributes: attributesOf(attributeLists),
        extra: {
          isAbstract: words.has("abstract") || (owner.isInterface && !hasBody),
          isVirtual: words.has("virtual"),
          isOverride: words.has("override"),
          accessors,
          parameters: JSON.stringify(parameters),
          ...(explicitInterface ? { explicitInterface } : {}),
        },
      });
      addAccessors(owner, member, "Item", "indexer", words, visibility, parameters, declaredType || null);
    };

    const handleEvent = (member: SyntaxNode, owner: Owner): void => {
      const name = nameText(member.childForFieldName("name"));
      if (!name) return;
      const { words, attributeLists } = modifiersOf(member);
      const explicitInterface = explicitInterfaceOf(member);
      const declaredType = typeText(member.childForFieldName("type"));
      const visibility: CSharpVisibility = explicitInterface ? "private" : visibilityOf(words, owner.isInterface ? "public" : "private");
      addField(owner, {
        node: member,
        name,
        declaredType,
        visibility,
        isStatic: words.has("static"),
        isReadonly: false,
        fieldKind: "event",
        attributes: attributesOf(attributeLists),
        extra: {
          isAbstract: words.has("abstract"),
          isVirtual: words.has("virtual"),
          isOverride: words.has("override"),
          accessors: accessorNames(member),
          ...(explicitInterface ? { explicitInterface } : {}),
        },
      });
      addAccessors(owner, member, name, "event", words, visibility, [], declaredType || null);
    };

    const handleMembers = (body: SyntaxNode, owner: Owner): void => {
      for (const member of body.namedChildren) {
        switch (member.type) {
          case "field_declaration":
          case "event_field_declaration":
            handleField(member, owner);
            break;
          case "method_declaration":
            handleMethod(member, owner);
            break;
          case "constructor_declaration":
            handleConstructor(member, owner);
            break;
          case "destructor_declaration":
            handleDestructor(member, owner);
            break;
          case "operator_declaration":
          case "conversion_operator_declaration":
            handleOperator(member, owner);
            break;
          case "property_declaration":
            handleProperty(member, owner);
            break;
          case "indexer_declaration":
            handleIndexer(member, owner);
            break;
          case "event_declaration":
            handleEvent(member, owner);
            break;
          case "enum_member_declaration": {
            const name = nameText(member.childForFieldName("name"));
            if (!name) break;
            addField(owner, {
              node: member, name, declaredType: owner.qualifiedName, visibility: "public", isStatic: true, isReadonly: true, fieldKind: "enum-constant",
              attributes: attributesOf(modifiersOf(member).attributeLists),
            });
            break;
          }
          default:
            if (typeDeclarationTypes.has(member.type)) handleType(member, owner, owner.namespace);
        }
      }
    };

    const addDelegateSignature = (node: SyntaxNode, owner: Owner): void => {
      owner.node.properties.parameters = JSON.stringify(csharpParameters(node.childForFieldName("parameters")));
      owner.node.properties.returnType = typeText(node.childForFieldName("type")) || null;
    };

    const handleType = (node: SyntaxNode, outer: Owner | null, namespace: string): Owner | null => {
      const name = nameText(node.childForFieldName("name"));
      let kind = kindOfDeclaration[node.type];
      if (kind === "record" && node.children.some((child) => child.type === "struct")) kind = "record struct";
      if (!name || !kind) return null;
      const { words, attributeLists } = modifiersOf(node);
      const owner = createOwner(node, kind, name, outer, namespace, words);
      if (plugins.length > 0) parsedTypes.push({ syntax: node, node: owner.node });
      addDecorators(owner.id, owner.isInterface ? "INTERFACE_HAS_DECORATOR" : "HAS_DECORATOR", attributesOf(attributeLists));
      if (kind === "delegate") {
        addDelegateSignature(node, owner);
        finish(owner);
        return owner;
      }
      // Primary constructor of a class, struct or record: `record P(int X, string Y)`, `class C(IService s)`.
      const primary = node.namedChildren.find((child) => child.type === "parameter_list");
      if (primary) {
        const parameters = csharpParameters(primary);
        owner.node.properties.primaryParameters = JSON.stringify(parameters);
        if (kind === "record" || kind === "record struct") {
          for (const parameter of parameters) {
            addField(owner, {
              node, name: parameter.name, declaredType: parameter.type, visibility: "public", isStatic: false, isReadonly: kind === "record" || words.has("readonly"),
              fieldKind: "record-component",
              attributes: [],
              extra: { accessors: kind === "record" ? "get,init" : "get,set" },
            });
          }
        }
        const { argumentLists } = baseListOf(node, kind);
        addFunction(owner, {
          node: primary, name: owner.name, kind: "constructor", methodKind: "primary", words: new Set(), attributes: [], parameters, returnType: null,
          visibility: owner.node.properties.visibility as CSharpVisibility, isAbstract: false, isStatic: false, typeParameters: [], roots: argumentLists,
        });
      }
      const body = node.childForFieldName("body");
      if (body) handleMembers(body, owner);
      finish(owner);
      return owner;
    };

    // Field initializers hold call sites too: they belong to a synthetic function per type
    // (`<clinit>` for static ones, `<init-block>` for instance ones).
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
          namespace: owner.namespace,
          qualifiedName: `${owner.qualifiedName}.${name}`,
          isStatic,
          parameterCount: 0,
          requiredParameterCount: 0,
          csharpLocals: JSON.stringify(Object.fromEntries(locals)),
        },
      };
      add(fn, owner.id, owner.isInterface ? "DEFINES_INTERFACE_METHOD" : "DEFINES_METHOD");
      walkCode(items, fn, locals);
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

    const handleUsing = (node: SyntaxNode, scope: string, block: { start: number; end: number } | null): void => {
      const children = node.children;
      const isAlias = children.some((child) => child.type === "=");
      const aliasNode = isAlias ? node.childForFieldName("name") : null;
      const target = node.namedChildren.filter((child) => !isComment(child) && child.id !== aliasNode?.id).at(-1);
      if (!target) return;
      const source = dottedName(target) ?? normalizeCSharpType(typeText(target)) ?? compactNoSpace(target.text);
      const isStatic = children.some((child) => child.type === "static");
      const line = node.startPosition.row + 1;
      const importKind = isAlias ? "alias" : isStatic ? "static" : "normal";
      const id = uniqueId(`${fileNodeId}:import:${line}:${isAlias ? `${plainName(aliasNode?.text ?? "")}=` : ""}${source}`, node);
      add({
        id,
        label: "Import",
        properties: {
          source,
          specifier: compact(node.text),
          line,
          isWildcard: false,
          isStatic,
          importKind,
          isGlobal: children.some((child) => child.type === "global"),
          usingScope: scope,
          // The lines of the namespace block the `using` is in: the same namespace opened twice in a file has two scopes.
          ...(block && scope !== "" ? { usingScopeStart: block.start, usingScopeEnd: block.end } : {}),
          ...(isAlias && trailingArity(typeText(target)) !== undefined ? { sourceArity: trailingArity(typeText(target)) } : {}),
          ...(aliasNode ? { alias: plainName(aliasNode.text) } : {}),
        },
      }, fileNodeId, "IMPORTS");
    };

    // Top level: usings, namespaces (block and file-scoped), types and top-level statements. Namespaces are scoped in one another, so the
    // walk keeps its own stack of scopes.
    const topLevel: SyntaxNode[] = [];
    type Frame = { children: readonly SyntaxNode[]; index: number; namespace: string; block: { start: number; end: number } | null };
    const frames: Frame[] = [{ children: tree.rootNode.namedChildren, index: 0, namespace: "", block: null }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      if (frame.index >= frame.children.length) {
        frames.pop();
        continue;
      }
      const child = frame.children[frame.index++]!;
      switch (child.type) {
        case "using_directive":
          handleUsing(child, frame.namespace, frame.block);
          break;
        case "namespace_declaration": {
          const name = child.childForFieldName("name");
          const namespace = qualify(frame.namespace, name ? plainName(compactNoSpace(name.text)) : "");
          namespaces.add(namespace);
          frames.push({ children: child.childForFieldName("body")?.namedChildren ?? [], index: 0, namespace, block: { start: child.startPosition.row + 1, end: child.endPosition.row + 1 } });
          break;
        }
        case "file_scoped_namespace_declaration": {
          const name = child.childForFieldName("name");
          if (name) {
            frame.namespace = qualify("", plainName(compactNoSpace(name.text)));
            frame.block = { start: child.startPosition.row + 1, end: Number.MAX_SAFE_INTEGER };
            namespaces.add(frame.namespace);
          }
          break;
        }
        case "global_statement":
          topLevel.push(child);
          break;
        default:
          if (typeDeclarationTypes.has(child.type)) handleType(child, null, frame.namespace);
      }
    }

    // Top-level statements are the body of a synthetic function; their calls belong to it.
    if (topLevel.length > 0) {
      fileNode.properties.hasTopLevelStatements = true;
      const locals = readLocals(topLevel, []);
      const first = topLevel[0]!;
      const fn: GraphNode = {
        id: `${fileNodeId}:function:${first.startPosition.row + 1}:<top-level>`,
        label: "Function",
        properties: {
          name: "<top-level>",
          kind: "top-level",
          methodKind: null,
          line: first.startPosition.row + 1,
          endLine: topLevel.at(-1)!.endPosition.row + 1,
          className: null,
          isExported: false,
          isAsync: false,
          isAbstract: false,
          visibility: "internal",
          parameters: "[]",
          returnType: null,
          namespace: "",
          qualifiedName: "<top-level>",
          isStatic: true,
          parameterCount: 0,
          requiredParameterCount: 0,
          csharpLocals: JSON.stringify(Object.fromEntries(locals)),
        },
      };
      add(fn, fileNodeId, "DEFINES_FUNCTION");
      usedIds.add(fn.id);
      if (plugins.length > 0) parsedFunctions.push({ syntax: tree.rootNode, node: fn });
      walkCode(topLevel, fn, locals);
    }

    for (const plugin of plugins) {
      plugin({ fileNodeId, root: tree.rootNode, nodes, relationships, functions: parsedFunctions, types: parsedTypes, calls: parsedCalls });
    }

    if (namespaces.size > 0) fileNode.properties.csharpNamespaces = JSON.stringify([...namespaces].sort());
    if (partialFacts.length > 0) fileNode.properties.csharpPartials = JSON.stringify(partialFacts);

    const parsed: ParsedSourceFile = { fileNodeId, nodes, relationships };
    if (skippedLines.length > 0) {
      parsed.warnings = [`Syntax error: left out the statement${skippedLines.length === 1 ? "" : "s"} at line${skippedLines.length === 1 ? "" : "s"} ${skippedLines.join(", ")}`];
    }
    return parsed;
  } finally {
    tree.delete();
  }
}
