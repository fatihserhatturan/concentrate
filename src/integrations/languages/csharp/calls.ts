import type { SyntaxNode } from "../syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import {
  argumentNodes,
  argumentValue,
  compactExpression,
  compactNoSpace,
  dottedName,
  genericTypeText,
  isComment,
  lastSegment,
  nameText,
  normalizeCSharpType,
  plainName,
  trailingArity,
  trailingGenericArguments,
  typeText,
  type CSharpLocal,
  type CSharpParameter,
} from "./syntax.js";

// Call sites and local variable types of C# code.
//
// `csharpLocals` (a JSON property of every Function node) maps each name declared inside the function, or
// one of its parameters, to what is known of its type: `{"type": "Foo"}` or `null` (a local whose type is
// not known: `var x = F()`, an untyped lambda parameter, a tuple deconstruction, a name declared twice with
// different types). Types are normalized names (generic arguments removed: `List<string>` is `List`; arrays
// keep `[]`). `var x = new T()`, `var x = (T)y` and `var x = y as T` are `{"type": "T"}`.
// A local function's name is a `null` entry too (a bare call of that name is the local function, never a method of
// the class). `var x = Make();` / `var x = obj.Prop;` / `var x = await M();` keep the initializer text
// (`{"initializer": "Make()"}`) for the resolver to type at resolution time.
// Local functions and lambdas are not functions of their own: their calls and names belong to the member
// that holds them.

// Longest receiver / expression text kept on a Call node (longer ones are cut and marked `receiverTruncated`).
export const MAX_RECEIVER_TEXT = 1000;
const MAX_STORED_TEXT = 160;
const MAX_INITIALIZER_TEXT = 300;

export type CSharpLocals = Map<string, CSharpLocal | null>;

/** The parameters of one lambda / anonymous method / local function and the range of its syntax (1-based rows, 0-based columns). */
export type CSharpLambdaScope = { r: [number, number, number, number]; l: Record<string, CSharpLocal | null> };

/**
 * `csharpLambdaLocals` (a JSON property of a Function node, only when it differs from `csharpLocals`): the typed
 * parameters of each lambda by range, so a receiver inside `(AppCtx db) => ...` is typed even when another lambda of the
 * same member names a parameter `db` of another type (the member-wide `csharpLocals` entry is then null).
 */
export function lambdaScopesProperty(scopes: readonly CSharpLambdaScope[], locals: CSharpLocals): string | undefined {
  const differs = scopes.some((scope) => Object.entries(scope.l).some(([name, local]) => local !== null && JSON.stringify(locals.get(name) ?? null) !== JSON.stringify(local)));
  return differs ? JSON.stringify(scopes) : undefined;
}

export type CSharpCallKind = "method" | "constructor" | "explicitConstructor";

function merge(locals: CSharpLocals, name: string, next: CSharpLocal | null): void {
  if (!locals.has(name)) {
    locals.set(name, next);
    return;
  }
  if (JSON.stringify(locals.get(name)) !== JSON.stringify(next)) locals.set(name, null);
}

function declared(typeNode: SyntaxNode | null, value: SyntaxNode | null): CSharpLocal | null {
  const written = typeText(typeNode);
  if (written === "var" || typeNode?.type === "implicit_type") return inferred(value);
  const type = normalizeCSharpType(written);
  if (!type) return null;
  const fullType = genericTypeText(written);
  return fullType && !type.endsWith("[]") ? { type, fullType } : { type };
}

// `var x = F();`, `var x = a.B;`, `var x = await F();`, `var y = x;`: nothing certain, but the resolver can type the
// expression later.
function initializerOf(value: SyntaxNode): CSharpLocal | null {
  let node: SyntaxNode | null = value;
  if (node.type === "await_expression") node = unwrap(node.namedChildren.find((child) => !isComment(child)) ?? null);
  if (!node || !["invocation_expression", "member_access_expression", "identifier"].includes(node.type)) return null;
  if (value.endIndex - value.startIndex > MAX_INITIALIZER_TEXT) return null;
  const text = compactExpression(value.text);
  return text.length <= MAX_INITIALIZER_TEXT ? { initializer: text } : null;
}

function unwrap(node: SyntaxNode | null): SyntaxNode | null {
  let value = node;
  while (value && (value.type === "parenthesized_expression" || (value.type === "postfix_unary_expression" && value.text.endsWith("!"))) && value.namedChildren[0]) value = value.namedChildren[0]!;
  return value;
}

function inferred(written: SyntaxNode | null): CSharpLocal | null {
  const value = unwrap(written);
  if (!value) return null;
  if (value.type === "object_creation_expression") {
    const text = typeText(value.childForFieldName("type"));
    const type = normalizeCSharpType(text);
    if (!type) return null;
    const fullType = genericTypeText(text);
    return fullType ? { type, fullType } : { type };
  }
  if (value.type === "invocation_expression" || value.type === "member_access_expression" || value.type === "await_expression" || value.type === "identifier") return initializerOf(value);
  if (value.type === "cast_expression") {
    const type = normalizeCSharpType(typeText(value.childForFieldName("type")));
    return type ? { type } : null;
  }
  if (value.type === "as_expression") {
    const type = normalizeCSharpType(typeText(value.childForFieldName("right")));
    return type ? { type } : null;
  }
  return null;
}

// The value expression of a `variable_declarator`: what follows its name (and a bracketed size).
export function declaratorValue(declarator: SyntaxNode): SyntaxNode | null {
  const name = declarator.childForFieldName("name");
  return declarator.namedChildren.filter((child) => child.id !== name?.id && child.type !== "bracketed_argument_list" && !isComment(child)).at(-1) ?? null;
}

// Names bound by a deconstruction `var (a, b)` or `(int a, var b)`: their types are not read.
function designationNames(root: SyntaxNode): string[] {
  const names: string[] = [];
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "identifier") names.push(plainName(node.text));
    else for (const child of node.namedChildren) stack.push(child);
  }
  return names;
}

// The parameters and the declarations of a body: `T x`, `var x = new T()`, for-each variables, using
// declarations, catch parameters, `is T x` patterns, `out T x`, lambda and local function parameters.
export function readLocals(roots: readonly SyntaxNode[], parameters: readonly CSharpParameter[], scopes?: CSharpLambdaScope[]): CSharpLocals {
  const locals: CSharpLocals = new Map();
  const scopeOf = (owner: SyntaxNode): CSharpLambdaScope => {
    const range: CSharpLambdaScope["r"] = [owner.startPosition.row + 1, owner.startPosition.column, owner.endPosition.row + 1, owner.endPosition.column];
    let scope = scopes!.find((item) => item.r[0] === range[0] && item.r[1] === range[1] && item.r[2] === range[2] && item.r[3] === range[3]);
    if (!scope) scopes!.push((scope = { r: range, l: {} }));
    return scope;
  };
  for (const parameter of parameters) {
    const type = normalizeCSharpType(parameter.type);
    const fullType = genericTypeText(parameter.type);
    merge(locals, parameter.name, type ? (fullType && !type.endsWith("[]") ? { type, fullType } : { type }) : null);
  }
  const visit = (node: SyntaxNode): void => {
    switch (node.type) {
      case "variable_declaration": {
        const typeNode = node.childForFieldName("type");
        for (const declarator of node.namedChildren.filter((child) => child.type === "variable_declarator")) {
          const name = nameText(declarator.childForFieldName("name"));
          if (name) merge(locals, name, declared(typeNode, declaratorValue(declarator)));
          else for (const bound of designationNames(declarator.namedChildren.find((child) => child.type !== "identifier") ?? declarator)) merge(locals, bound, null);
        }
        break;
      }
      case "foreach_statement": {
        const left = node.childForFieldName("left");
        if (left?.type === "identifier") merge(locals, plainName(left.text), declared(node.childForFieldName("type"), null));
        else if (left) for (const bound of designationNames(left)) merge(locals, bound, null);
        break;
      }
      case "catch_declaration": {
        const name = nameText(node.childForFieldName("name"));
        if (name) merge(locals, name, declared(node.childForFieldName("type"), null));
        break;
      }
      case "declaration_pattern":
      case "declaration_expression": {
        const name = nameText(node.childForFieldName("name"));
        if (name) merge(locals, name, declared(node.childForFieldName("type"), null));
        break;
      }
      case "single_variable_designation":
        merge(locals, plainName(node.text), null);
        break;
      case "local_function_statement": {
        const name = nameText(node.childForFieldName("name"));
        if (name) merge(locals, name, null);
        break;
      }
      case "parameter": {
        // A lambda or local function parameter (the member's own parameters are not in its body).
        const name = nameText(node.childForFieldName("name"));
        const typeNode = node.childForFieldName("type");
        const local = typeNode ? declared(typeNode, null) : null;
        if (name) merge(locals, name, local);
        const owner = node.parent?.parent;
        if (name && scopes && owner && (owner.type === "lambda_expression" || owner.type === "local_function_statement" || owner.type === "anonymous_method_expression")) scopeOf(owner).l[name] = local;
        break;
      }
      case "lambda_expression": {
        const list = node.childForFieldName("parameters");
        if (list?.type === "identifier") {
          merge(locals, plainName(list.text), null);
          if (scopes) scopeOf(node).l[plainName(list.text)] = null;
        }
        break;
      }
      default:
        break;
    }
  };
  // Iterative pre-order walk: expression chains can be thousands of levels deep.
  const stack: SyntaxNode[] = [];
  for (let r = roots.length - 1; r >= 0; r--) stack.push(roots[r]!);
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return locals;
}

export const callLikeTypes: ReadonlySet<string> = new Set([
  "invocation_expression",
  "object_creation_expression",
  "implicit_object_creation_expression",
  "constructor_initializer",
]);

// True when the code holds a call site.
export function hasCallSite(root: SyntaxNode): boolean {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (callLikeTypes.has(node.type)) return true;
    for (const child of node.namedChildren) stack.push(child);
  }
  return false;
}

const literalTypes: Readonly<Record<string, string>> = {
  string_literal: "string",
  verbatim_string_literal: "string",
  raw_string_literal: "string",
  interpolated_string_expression: "string",
  boolean_literal: "bool",
  character_literal: "char",
  null_literal: "null",
  typeof_expression: "Type",
};

// The type of one argument when it is certain from the call site alone, as a short token the resolver reads back:
// a type name (`string`, `int`, a class from `new T()`, the declared type of a typed local), `this`, `null`, or
// `@name` for a field or property (the resolver finds its type). Null for anything else.
function argumentType(argument: SyntaxNode, locals: CSharpLocals): string | null {
  const value = unwrap(argumentValue(argument));
  if (!value) return null;
  const literal = literalTypes[value.type];
  if (literal) return literal;
  switch (value.type) {
    case "integer_literal": {
      const suffix = /[lLuU]+$/u.exec(value.text)?.[0]?.toLowerCase() ?? "";
      return suffix.includes("u") && suffix.includes("l") ? "ulong" : suffix.includes("l") ? "long" : suffix.includes("u") ? "uint" : "int";
    }
    case "real_literal": {
      const suffix = /[fFmMdD]$/u.exec(value.text)?.[0]?.toLowerCase();
      return suffix === "f" ? "float" : suffix === "m" ? "decimal" : "double";
    }
    case "this":
      return "this";
    case "identifier": {
      const name = plainName(value.text);
      return locals.has(name) ? locals.get(name)?.type ?? null : `@${name}`;
    }
    case "member_access_expression": {
      const name = value.childForFieldName("name");
      return value.childForFieldName("expression")?.type === "this" && name?.type === "identifier" && !locals.has(plainName(name.text)) ? `@${plainName(name.text)}` : null;
    }
    case "object_creation_expression":
      return normalizeCSharpType(typeText(value.childForFieldName("type")));
    case "cast_expression":
      return normalizeCSharpType(typeText(value.childForFieldName("type")));
    case "as_expression":
      return normalizeCSharpType(typeText(value.childForFieldName("right")));
    default:
      return null;
  }
}

// The certain argument types of a call, as a JSON array with null for the uncertain ones; null when none is certain.
function argumentTypes(list: SyntaxNode | null | undefined, locals: CSharpLocals): string | null {
  const types = argumentNodes(list).map((argument) => argumentType(argument, locals));
  return types.some((type) => type !== null) ? JSON.stringify(types) : null;
}

// `Type.M()` and `a.b.C.M()` have a receiver that is a dotted name whose first segment is not a local: it is a
// type, a namespace-qualified type, or a field or property (or a chain of them).
function qualifierOf(receiver: SyntaxNode | null, locals: CSharpLocals): string | null {
  if (!receiver) return null;
  if (receiver.type === "predefined_type") return receiver.text;
  const name = dottedName(receiver);
  if (!name) return null;
  return locals.has(name.split(".")[0]!) ? null : name;
}

// How the receiver is written: `this`, `base`, `identifier` (a name), `member` (a dotted chain), `this-member` /
// `base-member` (`this.f.Go()`: a chain of members of `this`/`base`), `type` (a keyword type:
// `string.Join`), `new`, `invocation` (the result of a call), `element`, `cast` (`((T)x).M()`, `(x as T).M()`), `other`.
export function receiverKindOf(receiver: SyntaxNode | null): string | null {
  const node = unwrap(receiver);
  if (!node) return null;
  switch (node.type) {
    case "this":
      return "this";
    case "base":
      return "base";
    case "identifier":
    case "generic_name":
      return "identifier";
    case "predefined_type":
      return "type";
    case "member_access_expression":
    case "qualified_name":
    case "alias_qualified_name": {
      if (dottedName(node)) return "member";
      // `this.f.Go()`: a chain of members of `this` (or `base`).
      let root: SyntaxNode | null = node;
      while (root?.type === "member_access_expression") root = root.childForFieldName("expression");
      return root?.type === "this" ? "this-member" : root?.type === "base" ? "base-member" : "other";
    }
    case "object_creation_expression":
    case "implicit_object_creation_expression":
      return "new";
    case "invocation_expression":
      return "invocation";
    case "element_access_expression":
      return "element";
    case "cast_expression":
    case "as_expression":
      return "cast";
    default:
      return "other";
  }
}

function receiverProperties(receiver: SyntaxNode | null, locals: CSharpLocals): Record<string, string | boolean> {
  const node = unwrap(receiver);
  if (!node) return {};
  if (node.type === "object_creation_expression") {
    const type = normalizeCSharpType(typeText(node.childForFieldName("type")));
    return type ? { receiverConstructor: type } : {};
  }
  if (node.type === "cast_expression" || node.type === "as_expression") {
    const type = normalizeCSharpType(typeText(node.childForFieldName(node.type === "cast_expression" ? "type" : "right")));
    return type ? { receiverType: type } : {};
  }
  if (node.type !== "identifier" || !locals.has(plainName(node.text))) return {};
  const local = locals.get(plainName(node.text));
  return local?.type ? { receiverIsLocal: true, receiverType: local.type } : { receiverIsLocal: true };
}

// The receiver of a call as stored: its compacted text, or (when longer than `MAX_RECEIVER_TEXT`, without reading all of
// it) a cut prefix marked truncated. A truncated receiver is never evaluated.
function receiverOf(node: SyntaxNode): { text: string; truncated: boolean } {
  if (node.endIndex - node.startIndex > MAX_RECEIVER_TEXT) return { text: `${compactExpression(node.text.slice(0, MAX_STORED_TEXT))}~${node.startIndex}-${node.endIndex}`, truncated: true };
  const text = compactExpression(node.text);
  return text.length > MAX_RECEIVER_TEXT ? { text: `${text.slice(0, MAX_STORED_TEXT)}~${node.startIndex}-${node.endIndex}`, truncated: true } : { text, truncated: false };
}

function build(
  functionId: string,
  node: SyntaxNode,
  expression: string,
  callee: string,
  receiver: SyntaxNode | null,
  receiverText: string | null,
  kind: CSharpCallKind,
  extra: Record<string, string | number | boolean | null>,
  locals: CSharpLocals,
): GraphNode {
  const line = node.startPosition.row + 1;
  const qualifier = qualifierOf(unwrap(receiver), locals);
  const receiverKind = receiverKindOf(receiver);
  // A long expression (`a.B().C()...`) is cut for the id and the name; the position keeps the id unique.
  const shown = expression.length > MAX_STORED_TEXT ? `${expression.slice(0, MAX_STORED_TEXT)}~${expression.length}` : expression;
  return {
    id: `${functionId}:call:${line}:${node.startPosition.column}:${shown}`,
    label: "Call",
    properties: {
      name: shown,
      expression: shown,
      callee,
      receiver: receiverText,
      line,
      columnNumber: node.startPosition.column,
      callKind: kind,
      ...(receiverKind === null ? {} : { receiverKind }),
      ...(receiverText !== null && receiverText.includes("~") && /~\d+-\d+$/u.test(receiverText) ? { receiverTruncated: true } : {}),
      ...(qualifier === null ? {} : { qualifier }),
      ...receiverProperties(receiver, locals),
      ...extra,
    },
  };
}

function withArguments(node: SyntaxNode, locals: CSharpLocals): Record<string, string | number> {
  const list = node.childForFieldName("arguments") ?? node.namedChildren.find((child) => child.type === "argument_list") ?? null;
  const types = argumentTypes(list, locals);
  return { argumentCount: argumentNodes(list).length, ...(types === null ? {} : { argumentTypes: types }) };
}

// The simple name and generic arguments of a method name (`Gen<int>` is `Gen`, `int`).
function nameAndTypeArguments(node: SyntaxNode | null): { name: string; typeArguments: string | null } | null {
  if (!node) return null;
  if (node.type === "identifier") return { name: plainName(node.text), typeArguments: null };
  if (node.type === "generic_name") {
    const id = node.namedChildren.find((child) => child.type === "identifier");
    const list = node.namedChildren.find((child) => child.type === "type_argument_list");
    return id ? { name: plainName(id.text), typeArguments: list ? compactNoSpace(list.text).slice(1, -1) : null } : null;
  }
  return null;
}

// What `new()` constructs when the declaration around it says so: `Foo x = new();`, a field or property `Foo X = new();`,
// `x = new();` for a local `x` of known type. Null when the type is not written anywhere near.
function implicitTargetType(node: SyntaxNode, locals: CSharpLocals): { type: string; written: string } | null {
  const parent = node.parent;
  if (!parent) return null;
  const from = (text: string | null | undefined): { type: string; written: string } | null => {
    const type = normalizeCSharpType(text);
    return type ? { type, written: text! } : null;
  };
  if (parent.type === "variable_declarator" && parent.parent?.type === "variable_declaration") return from(typeText(parent.parent.childForFieldName("type")));
  if (parent.type === "property_declaration") return from(typeText(parent.childForFieldName("type")));
  if (parent.type === "assignment_expression" && parent.childForFieldName("right")?.id === node.id) {
    const left = parent.childForFieldName("left");
    if (left?.type === "identifier") {
      const local = locals.get(plainName(left.text));
      return local?.type ? { type: local.type, written: local.fullType ?? local.type } : null;
    }
  }
  return null;
}

// `typeArity` of a constructor call: the generic arguments the type was written with (`new Box<string>()` is 1).
function typeArityProperties(written: string): Record<string, string | number> {
  const args = trailingGenericArguments(written);
  const arity = trailingArity(written);
  return args !== null && arity !== undefined ? { typeArity: arity, typeArguments: args.join(",") } : {};
}

// The Call node of an invocation, `new T(...)`, target-typed `new(...)` or `this(...)` / `base(...)`; null when `node`
// is none of them or its callee is not a name (a call of a call result, of a parenthesized expression).
export function createCallNode(functionId: string, node: SyntaxNode, locals: CSharpLocals): GraphNode | null {
  switch (node.type) {
    case "invocation_expression": {
      const fn = node.childForFieldName("function");
      if (!fn) return null;
      const args = withArguments(node, locals);
      if (fn.type === "identifier" || fn.type === "generic_name") {
        const parts = nameAndTypeArguments(fn);
        if (!parts) return null;
        return build(functionId, node, parts.name, parts.name, null, null, "method", { ...args, ...(parts.typeArguments ? { typeArguments: parts.typeArguments } : {}) }, locals);
      }
      if (fn.type === "member_access_expression") {
        const parts = nameAndTypeArguments(fn.childForFieldName("name"));
        const object = fn.childForFieldName("expression");
        if (!parts || !object) return null;
        const stored = receiverOf(object);
        return build(functionId, node, `${stored.text}.${parts.name}`, parts.name, object, stored.text, "method", { ...args, ...(parts.typeArguments ? { typeArguments: parts.typeArguments } : {}) }, locals);
      }
      if (fn.type === "conditional_access_expression") {
        const condition = fn.childForFieldName("condition");
        const tail = fn.namedChildren.filter((child) => child.id !== condition?.id && !isComment(child)).at(-1);
        if (!condition || !tail) return null;
        let nameNode: SyntaxNode | null = null;
        let receiver: SyntaxNode | null = condition;
        let receiverText = receiverOf(condition).text;
        if (tail.type === "member_binding_expression") {
          nameNode = tail.childForFieldName("name");
        } else if (tail.type === "member_access_expression") {
          nameNode = tail.childForFieldName("name");
          // `a?.B.C()`: the receiver is everything before `.C`.
          receiver = null;
          const cut = (nameNode?.startIndex ?? fn.endIndex) - fn.startIndex;
          receiverText = (cut > MAX_RECEIVER_TEXT ? `${compactExpression(fn.text.slice(0, MAX_STORED_TEXT))}~${fn.startIndex}-${fn.startIndex + cut}` : compactExpression(fn.text.slice(0, cut))).replace(/\.$/u, "");
        } else return null;
        const parts = nameAndTypeArguments(nameNode);
        if (!parts) return null;
        return build(functionId, node, `${receiverText}?.${parts.name}`, parts.name, receiver, receiverText, "method", { ...args, isConditional: true, ...(parts.typeArguments ? { typeArguments: parts.typeArguments } : {}) }, locals);
      }
      return null;
    }
    case "object_creation_expression": {
      const typeNode = node.childForFieldName("type");
      const type = normalizeCSharpType(typeText(typeNode));
      if (!type) return null;
      const call = build(functionId, node, `new ${type}`, lastSegment(type), null, null, "constructor", { ...withArguments(node, locals), ...typeArityProperties(typeText(typeNode)) }, locals);
      if (type.includes(".")) call.properties.qualifier = type.slice(0, type.lastIndexOf("."));
      return call;
    }
    case "implicit_object_creation_expression": {
      const target = implicitTargetType(node, locals);
      if (!target) return build(functionId, node, "new()", "new", null, null, "constructor", { ...withArguments(node, locals), receiverKind: "implicit-new" }, locals);
      const { type } = target;
      const call = build(functionId, node, `new ${type}`, lastSegment(type), null, null, "constructor", { ...withArguments(node, locals), ...typeArityProperties(target.written), receiverKind: "implicit-new" }, locals);
      if (type.includes(".")) call.properties.qualifier = type.slice(0, type.lastIndexOf("."));
      return call;
    }
    case "constructor_initializer": {
      const target = node.children.find((child) => child.type === "this" || child.type === "base");
      if (!target) return null;
      return build(functionId, node, target.type, target.type, null, null, "explicitConstructor", withArguments(node, locals), locals);
    }
    default:
      return null;
  }
}
