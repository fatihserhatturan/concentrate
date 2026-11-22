import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import { argumentNodes, argumentValue, compactNoSpace, csharpParameters, isComment, plainName, typeText, type CSharpParameter } from "../../languages/csharp/syntax.js";
import { csharpStringLiteral } from "./attributes.js";

// Parse-time syntax helpers for the C# parse plugins (`CSharpParsePlugin` in languages/csharp/parser.ts): what the
// graph does not keep of a call site (lambda bodies, argument expressions, the receiver chain). Plugins use them on
// the `syntax` of an entry of `file.calls` (an `invocation_expression` or `object_creation_expression`).

export type ArgumentKind = "string" | "lambda" | "method-group" | "typeof" | "other";

export type ArgumentInfo = {
  /** `name: value` argument name, else null. */
  name: string | null;
  /** The value expression (without `name:`, `ref`, `out`). */
  node: SyntaxNode;
  /** `string`: a plain/verbatim/raw literal or literals joined by `+` (`value` is set); `lambda`: lambda or anonymous method; `method-group`: an identifier or `A.B.C` member access; `typeof`: `typeof(X)` (`typeName` is set). */
  kind: ArgumentKind;
  text: string;
  /** The string value for `kind: "string"`. */
  value?: string;
  /** The type text written inside `typeof(...)`. */
  typeName?: string;
};

export type InvocationInfo = {
  /** The syntax node (`invocation_expression`). */
  node: SyntaxNode;
  /** Method name without generic arguments: `MapGet`, `AddScoped`. */
  name: string;
  /** Generic arguments as written: `AddScoped<IFoo, Foo>` gives `["IFoo", "Foo"]`. */
  typeArguments: string[];
  /** The expression before `.name`: `app`, `app.MapGroup("/api")`, `services`. Null for a bare call `Foo(...)`. */
  receiver: SyntaxNode | null;
  arguments: ArgumentInfo[];
};

const isLambda = (node: SyntaxNode): boolean => node.type === "lambda_expression" || node.type === "anonymous_method_expression";

/** The string a literal (or `+`-joined literals) node means, null for anything else (including `$"..."`). */
export const stringValueOf = (node: SyntaxNode | null | undefined): string | null => (node ? csharpStringLiteral(node.text) : null);

/** Splits one `argument` node. */
export function argumentInfo(argument: SyntaxNode): ArgumentInfo | null {
  const node = argumentValue(argument);
  if (!node) return null;
  const nameColon = argument.namedChildren.find((child) => child.type === "name_colon");
  const name = nameColon ? plainName(nameColon.text).replace(/\s*:$/u, "").trim() : null;
  const info: ArgumentInfo = { name, node, kind: "other", text: node.text };
  const value = stringValueOf(node);
  if (value !== null) {
    info.kind = "string";
    info.value = value;
  } else if (isLambda(node)) info.kind = "lambda";
  else if (node.type === "typeof_expression") {
    info.kind = "typeof";
    const written = node.namedChildren.find((child) => !isComment(child));
    if (written) info.typeName = typeText(written);
  } else if (node.type === "identifier" || node.type === "member_access_expression") info.kind = "method-group";
  return info;
}

/** The name, generic arguments, receiver and arguments of an `invocation_expression`; null for any other node or a shape without a method name. */
export function invocationInfo(node: SyntaxNode): InvocationInfo | null {
  if (node.type !== "invocation_expression") return null;
  const fn = node.childForFieldName("function");
  if (!fn) return null;
  let nameNode: SyntaxNode | null = fn;
  let receiver: SyntaxNode | null = null;
  if (fn.type === "member_access_expression") {
    nameNode = fn.childForFieldName("name");
    receiver = fn.childForFieldName("expression");
  } else if (fn.type === "conditional_access_expression") return null;
  if (!nameNode) return null;
  let name: string;
  let typeArguments: string[] = [];
  if (nameNode.type === "generic_name") {
    const id = nameNode.namedChildren.find((child) => child.type === "identifier");
    if (!id) return null;
    name = plainName(id.text);
    const list = nameNode.namedChildren.find((child) => child.type === "type_argument_list");
    typeArguments = list ? list.namedChildren.filter((child) => !isComment(child)).map(typeText) : [];
  } else if (nameNode.type === "identifier") name = plainName(nameNode.text);
  else return null;
  const list = node.childForFieldName("arguments") ?? node.namedChildren.find((child) => child.type === "argument_list") ?? null;
  const args = argumentNodes(list).flatMap((argument) => {
    const info = argumentInfo(argument);
    return info ? [info] : [];
  });
  return { node, name, typeArguments, receiver, arguments: args };
}

/** The `invocation_expression` a receiver expression is, when it is one (`app.MapGroup("/a")` before `.MapGet`), else null. */
export const receiverInvocation = (receiver: SyntaxNode | null): SyntaxNode | null => {
  let current = receiver;
  while (current && current.type === "parenthesized_expression") current = current.namedChildren.find((child) => !isComment(child)) ?? null;
  return current?.type === "invocation_expression" ? current : null;
};

/**
 * The call chain `a.B(...).C(...).D(...)` of a call as invocations from the first to the last (`B`, `C`, `D`), and the
 * root expression the chain starts at (`a`; a non-call expression, or null).
 */
export function invocationChain(node: SyntaxNode): { root: SyntaxNode | null; chain: InvocationInfo[] } {
  const chain: InvocationInfo[] = [];
  let current: SyntaxNode | null = node;
  let root: SyntaxNode | null = null;
  while (current) {
    const info = invocationInfo(current);
    if (!info) {
      root = current;
      break;
    }
    chain.unshift(info);
    const next = receiverInvocation(info.receiver);
    if (!next) {
      root = info.receiver;
      break;
    }
    current = next;
  }
  return { root, chain };
}

/** The dotted text of an expression made of identifiers and member accesses (`app`, `Results.Ok`, `this.app`); null otherwise. */
export function dottedText(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "identifier") return plainName(node.text);
  if (node.type === "this_expression" || node.type === "this") return "this";
  if (node.type === "member_access_expression") {
    const object = dottedText(node.childForFieldName("expression"));
    const name = node.childForFieldName("name");
    return object !== null && name?.type === "identifier" ? `${object}.${plainName(name.text)}` : null;
  }
  return null;
}

export type LambdaInfo = {
  node: SyntaxNode;
  isAsync: boolean;
  /** Typed parameters (`(IFoo foo, [FromServices] Bar b) =>`) with their attributes; untyped ones have `type: ""`. */
  parameters: CSharpParameter[];
  /** A block, or the expression of an expression-bodied lambda. */
  body: SyntaxNode | null;
};

/** Reads a lambda or anonymous method; null for other nodes. */
export function lambdaInfo(node: SyntaxNode): LambdaInfo | null {
  if (!isLambda(node)) return null;
  const isAsync = node.children.some((child) => child.type === "modifier" && child.text === "async");
  const list = node.namedChildren.find((child) => child.type === "parameter_list");
  let parameters: CSharpParameter[] = [];
  if (list) parameters = csharpParameters(list);
  else {
    const implicit = node.namedChildren.find((child) => child.type === "implicit_parameter" || (child.type === "identifier" && child.id !== node.childForFieldName("body")?.id));
    if (implicit) parameters = [{ name: plainName(compactNoSpace(implicit.text)), type: "" }];
  }
  const body = node.childForFieldName("body") ?? node.namedChildren.at(-1) ?? null;
  return { node, isAsync, parameters, body };
}

/** Descendants of `root` (itself included) whose type is in `types`, in source order, without recursion. */
export function descendantsOfType(root: SyntaxNode, types: ReadonlySet<string>): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (types.has(node.type)) found.push(node);
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]!);
  }
  return found;
}
