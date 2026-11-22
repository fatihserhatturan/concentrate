import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";

// A C# Function with the File that really declares it. A `partial` type has one shared Class node linked from every
// declaring file, so the file comes from the member's own id (`file:<path>:function:<line>:<name>`), not from the owner.
export type CSharpMethod = { node: GraphNode; owner: GraphNode; fileId: string };

const FILE_OF_MEMBER = /^(file:.+?):(?:function|field|class|interface):\d+:/u;

export function csharpMethods(graph: IGraphContributor): CSharpMethod[] {
  const methods: CSharpMethod[] = [];
  for (const type of ["DEFINES_METHOD", "DEFINES_INTERFACE_METHOD"] as const) {
    for (const rel of graph.relationshipsOfType(type as GraphRelationship["type"])) {
      const owner = graph.node(rel.from);
      const node: GraphNode | undefined = graph.node(rel.to);
      const fileId = node ? FILE_OF_MEMBER.exec(node.id)?.[1] : undefined;
      if (!owner || !node || !fileId || graph.node(fileId)?.properties.language !== "csharp") continue;
      methods.push({ node, owner, fileId });
    }
  }
  return methods;
}

// The File id a graph node id belongs to: members, decorators and calls are `file:<path>:<kind>:<line>...`.
// The kind segment is `:<kind>:<line>` (a digit run then `:` or the end), so a directory such as `class1/` or `call/` is not one.
const FILE_OF_ID = /^(file:.+?):(?:function|field|class|interface|decorator|call):\d+(?::|$)/u;
export const csharpFileOfId = (id: string): string | undefined => FILE_OF_ID.exec(id)?.[1];

// Reads a JSON-list property (`parameters`, `primaryParameters`, `bases`, `baseNames`, `typeParameters`); [] when absent or broken.
export function jsonList<T = unknown>(value: unknown): T[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

// A parameter as the parser keeps it in a Function's `parameters` (and a type's `primaryParameters`) JSON:
// `type` as written, `modifier` (`ref`, `out`, `in`, `this`), and `annotations` (the attributes written on it: `name` as
// written, `args` as the Decorator `args`).
export type CSharpParameterInfo = {
  name: string;
  type: string;
  modifier?: string;
  params?: true;
  optional?: true;
  defaultValue?: string;
  annotations?: Array<{ name: string; args: string[] }>;
};

export const parametersOf = (node: GraphNode): CSharpParameterInfo[] => jsonList<CSharpParameterInfo>(node.properties.parameters);
export const primaryParametersOf = (node: GraphNode): CSharpParameterInfo[] => jsonList<CSharpParameterInfo>(node.properties.primaryParameters);
// In source order: the base class (if any) then interfaces; `name` has no generic arguments, `text` is as written.
export const basesOf = (node: GraphNode): Array<{ name: string; text: string; relation: string }> => jsonList(node.properties.bases);

// Every C# type (Class node: class, struct, record, record struct, enum, delegate; Interface node) of the scan.
export function csharpTypeNodes(graph: IGraphContributor): GraphNode[] {
  const types: GraphNode[] = [];
  for (const label of ["Class", "Interface"] as const) {
    for (const node of graph.nodesWithLabel(label)) {
      if (typeof node.properties.qualifiedName === "string" && typeof node.properties.arity === "number" && typeof node.properties.nesting === "string") types.push(node);
    }
  }
  return types;
}
