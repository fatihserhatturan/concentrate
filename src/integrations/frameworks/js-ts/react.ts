import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { JsTsParsedFile } from "../../languages/js-ts/index.js";

// React components: functions named in PascalCase that return JSX (or are
// typed `FC`), classes that extend `Component` / `PureComponent`, and
// `memo` / `forwardRef` wrappers. Contexts from `createContext` are
// components of kind `context`. The JSX elements a component renders are
// recorded on it as `pendingRenders` and the hooks it calls as `hooks`; the
// component-graph contributor links them across files.

export type PendingRender = { name: string; props: string[]; line: number };

type ComponentCandidate = {
  name: string;
  kind: "function" | "class" | "memo" | "forwardRef" | "context";
  line: number;
  endLine: number | null;
  isExported: boolean;
  definedBy: { functionId?: string; classId?: string };
  renderRoots: SyntaxNode[];
};

const classBases = new Set(["Component", "PureComponent", "React.Component", "React.PureComponent"]);
const wrappers = new Map([
  ["memo", "memo"],
  ["React.memo", "memo"],
  ["forwardRef", "forwardRef"],
  ["React.forwardRef", "forwardRef"],
] as const);
const componentTypes = /^(React\.)?(FC|FunctionComponent|VFC)\b/u;

export function applyReactParseSemantics({ fileNodeId, parsed, state }: JsTsParsedFile): void {
  const nodesById = new Map(parsed.nodes.map((node) => [node.id, node]));
  const astByFunctionId = new Map(state.functionAstPairs.map((pair) => [pair.functionNodeId, pair.astNode]));
  const functionIdByAstId = new Map(state.functionAstPairs.map((pair) => [pair.astNode.id, pair.functionNodeId]));
  const fileFunctionIds = new Set<string>();
  const fileClassIds = new Set<string>();
  const methodIdsByClass = new Map<string, string[]>();
  for (const rel of parsed.relationships) {
    if (rel.type === "DEFINES_FUNCTION" && rel.from === fileNodeId) fileFunctionIds.add(rel.to);
    else if (rel.type === "DEFINES_CLASS" && rel.from === fileNodeId) fileClassIds.add(rel.to);
    else if (rel.type === "DEFINES_METHOD") methodIdsByClass.set(rel.from, [...(methodIdsByClass.get(rel.from) ?? []), rel.to]);
  }

  const candidates: ComponentCandidate[] = [];

  // export const CartContext = createContext<Cart | null>(null)
  for (const declarator of state.variableDeclaratorAstNodes) {
    const name = declarator.childForFieldName("name");
    const value = declarator.childForFieldName("value");
    const callee = value?.type === "call_expression" ? value.childForFieldName("function")?.text : undefined;
    if (name?.type !== "identifier" || (callee !== "createContext" && callee !== "React.createContext")) continue;
    candidates.push({
      name: name.text,
      kind: "context",
      line: declarator.startPosition.row + 1,
      endLine: declarator.endPosition.row + 1,
      isExported: declarator.parent?.parent?.type === "export_statement",
      definedBy: {},
      renderRoots: [],
    });
  }
  // Functions wrapped under their own name: `const Card = memo(function Card() {…})`.
  const wrappedNames = new Map<string, string>();

  // const Card = memo((props) => …) / forwardRef(function Card(props, ref) { … }) / memo(Card)
  for (const declarator of state.variableDeclaratorAstNodes) {
    const name = declarator.childForFieldName("name");
    const value = declarator.childForFieldName("value");
    if (name?.type !== "identifier" || !isComponentName(name.text) || value?.type !== "call_expression") continue;
    const kind = wrappers.get(value.childForFieldName("function")?.text as never);
    const inner = value.childForFieldName("arguments")?.namedChildren[0];
    if (!kind || !inner) continue;

    const innerFunctionId = inner.type === "identifier"
      ? functionIdByName(inner.text, fileFunctionIds, nodesById)
      : functionIdByAstId.get(inner.id);
    if (!innerFunctionId) continue;
    wrappedNames.set(innerFunctionId, name.text);
    const innerAst = astByFunctionId.get(innerFunctionId);
    candidates.push({
      name: name.text,
      kind,
      line: declarator.startPosition.row + 1,
      endLine: declarator.endPosition.row + 1,
      isExported: declarator.parent?.parent?.type === "export_statement",
      definedBy: { functionId: innerFunctionId },
      renderRoots: inner.type === "identifier" || !innerAst ? [] : [innerAst],
    });
  }

  for (const functionId of fileFunctionIds) {
    const node = nodesById.get(functionId);
    const ast = astByFunctionId.get(functionId);
    const name = node?.properties.name;
    if (!node || !ast || typeof name !== "string" || !isComponentName(name)) continue;
    if (!returnsJsx(ast) && !hasComponentType(ast)) continue;
    // `const MemoCard = memo(Card)` keeps Card a component of its own.
    if (wrappedNames.get(functionId) === name) continue;
    candidates.push({
      name,
      kind: "function",
      line: Number(node.properties.line),
      endLine: typeof node.properties.endLine === "number" ? node.properties.endLine : null,
      isExported: node.properties.isExported === true,
      definedBy: { functionId },
      renderRoots: [ast],
    });
  }

  for (const classId of fileClassIds) {
    const node = nodesById.get(classId);
    const name = node?.properties.name;
    if (!node || typeof name !== "string" || !extendsComponent(node)) continue;
    const render = (methodIdsByClass.get(classId) ?? []).find((id) => nodesById.get(id)?.properties.name === "render");
    const renderAst = render ? astByFunctionId.get(render) : undefined;
    candidates.push({
      name,
      kind: "class",
      line: Number(node.properties.line),
      endLine: typeof node.properties.endLine === "number" ? node.properties.endLine : null,
      isExported: node.properties.isExported === true,
      definedBy: { classId },
      renderRoots: renderAst ? [renderAst] : [],
    });
  }

  const framework = jsxFramework(parsed.nodes, parsed.relationships, fileNodeId);
  const hooksByFunctionId = hookCallNames(parsed.nodes, parsed.relationships);
  const defaultExport = nodesById.get(fileNodeId)?.properties.defaultExport;
  for (const candidate of candidates) {
    const renders = candidate.renderRoots.flatMap(collectRenders);
    const component: GraphNode = {
      id: `${fileNodeId}:component:${candidate.line}:${candidate.name}`,
      label: "Component",
      properties: {
        name: candidate.name,
        framework,
        kind: candidate.kind,
        line: candidate.line,
        endLine: candidate.endLine,
        isExported: candidate.isExported || candidate.name === defaultExport,
        pendingRenders: renders.length > 0 ? JSON.stringify(renders) : null,
        hooks: candidate.definedBy.functionId ? hooksByFunctionId.get(candidate.definedBy.functionId)?.join(",") ?? null : null,
      },
    };
    parsed.nodes.push(component);
    parsed.relationships.push({ from: fileNodeId, to: component.id, type: "DECLARES_COMPONENT", properties: {} });
    if (candidate.definedBy.classId) {
      parsed.relationships.push({ from: component.id, to: candidate.definedBy.classId, type: "COMPONENT_DEFINED_BY", properties: {} });
    } else if (candidate.definedBy.functionId) {
      parsed.relationships.push({ from: component.id, to: candidate.definedBy.functionId, type: "COMPONENT_DEFINED_BY_FUNCTION", properties: {} });
    }
  }
}

// `useState()`, `React.useEffect()`, `useCart()`, React 19's `use(Ctx)`: a
// call named like a hook.
export function isHookCall(call: GraphNode): boolean {
  const callee = call.properties.callee;
  const receiver = call.properties.receiver;
  return typeof callee === "string" && /^use([A-Z0-9]|$)/u.test(callee) && (receiver === null || receiver === undefined || receiver === "React");
}

// The hooks each function calls, sorted and without repeats.
function hookCallNames(nodes: GraphNode[], relationships: GraphRelationship[]): Map<string, string[]> {
  const calls = new Map(nodes.filter((node) => node.label === "Call" && isHookCall(node)).map((node) => [node.id, String(node.properties.callee)]));
  const names = new Map<string, Set<string>>();
  for (const rel of relationships) {
    const callee = rel.type === "CALLS" ? calls.get(rel.to) : undefined;
    if (!callee) continue;
    let set = names.get(rel.from);
    if (!set) names.set(rel.from, set = new Set());
    set.add(callee);
  }
  return new Map([...names].map(([id, set]) => [id, [...set].sort()]));
}

// Synthetic names (`<memo:arg0>`) never qualify; neither does a lone capital.
function isComponentName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_$]*$/u.test(name) && name.length > 1;
}

function functionIdByName(name: string, functionIds: ReadonlySet<string>, nodesById: Map<string, GraphNode>): string | undefined {
  for (const id of functionIds) {
    if (nodesById.get(id)?.properties.name === name) return id;
  }
  return undefined;
}

function extendsComponent(classNode: GraphNode): boolean {
  if (typeof classNode.properties.extendsNames !== "string") return false;
  try {
    const parents = JSON.parse(classNode.properties.extendsNames) as unknown;
    return Array.isArray(parents) && parents.some((parent) => classBases.has(String(parent).replace(/<[\s\S]*$/u, "")));
  } catch {
    return false;
  }
}

// `const Card: FC<Props> = (props) => …`
function hasComponentType(functionAst: SyntaxNode): boolean {
  const declarator = functionAst.parent;
  if (declarator?.type !== "variable_declarator") return false;
  const type = declarator.childForFieldName("type")?.text.replace(/^:\s*/u, "");
  return type !== undefined && componentTypes.test(type);
}

const jsxTypes = new Set(["jsx_element", "jsx_self_closing_element", "jsx_fragment"]);

// The function returns JSX itself: an arrow with a JSX body, or a `return`
// of its own (not of a nested function) whose value is JSX, through
// parentheses, `cond ? a : b` and `cond && a`.
function returnsJsx(functionAst: SyntaxNode): boolean {
  const body = functionAst.childForFieldName("body");
  if (!body) return false;
  if (body.type !== "statement_block") return isJsxValue(body);

  const visit = (node: SyntaxNode): boolean => {
    if (node.type === "return_statement") {
      const value = node.namedChildren[0];
      return value ? isJsxValue(value) : false;
    }
    if (isNestedFunction(node)) return false;
    return node.namedChildren.some((child) => child !== null && visit(child));
  };
  return visit(body);
}

function isJsxValue(node: SyntaxNode): boolean {
  if (jsxTypes.has(node.type)) return true;
  if (node.type === "parenthesized_expression") return node.namedChildren.some((child) => child !== null && isJsxValue(child));
  if (node.type === "ternary_expression") {
    return [node.childForFieldName("consequence"), node.childForFieldName("alternative")].some((child) => child && isJsxValue(child));
  }
  if (node.type === "binary_expression") {
    const operator = node.childForFieldName("operator")?.text;
    const right = node.childForFieldName("right");
    return (operator === "&&" || operator === "||" || operator === "??") && right !== null && isJsxValue(right);
  }
  return false;
}

function isNestedFunction(node: SyntaxNode): boolean {
  return ["arrow_function", "function_expression", "function_declaration", "generator_function_declaration", "method_definition", "class_declaration", "class"].includes(node.type);
}

// Elements whose tag is a component (`<UserCard …>`, `<Layout.Header>`), with
// their prop names. Lowercase tags are DOM elements.
function collectRenders(root: SyntaxNode): PendingRender[] {
  const renders: PendingRender[] = [];
  const visit = (node: SyntaxNode) => {
    if (node.type === "jsx_opening_element" || node.type === "jsx_self_closing_element") {
      const name = node.childForFieldName("name")?.text;
      if (name && (/^[A-Z]/u.test(name) || /^[A-Za-z_$][\w$]*\.[A-Z]/u.test(name))) {
        const props = node.namedChildren
          .filter((child) => child?.type === "jsx_attribute")
          .map((attribute) => attribute!.namedChildren[0]?.text)
          .filter((prop): prop is string => typeof prop === "string");
        renders.push({ name, props, line: node.startPosition.row + 1 });
      }
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(root);
  return renders;
}

// JSX components are React's unless the file imports Preact or Solid.
function jsxFramework(nodes: GraphNode[], relationships: GraphRelationship[], fileNodeId: string): string {
  const importIds = new Set(relationships.filter((rel) => rel.from === fileNodeId && rel.type === "IMPORTS").map((rel) => rel.to));
  for (const node of nodes) {
    if (node.label !== "Import" || !importIds.has(node.id) || typeof node.properties.source !== "string") continue;
    if (node.properties.source === "preact" || node.properties.source.startsWith("preact/")) return "preact";
    if (node.properties.source === "solid-js" || node.properties.source.startsWith("solid-js/")) return "solid";
  }
  return "react";
}
