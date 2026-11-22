import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode } from "../../../core/graph/model.js";
import { csharpMethods } from "./shared.js";

type Parameter = { name?: string; type?: string | null; modifier?: string };

const compact = (type: string | null | undefined): string => (type ?? "").replace(/\s+/gu, "").replace(/^global::/u, "").replace(/^System\.(?:Threading\.Tasks\.)?/u, "");

// `void`, `int`, `Task`, `Task<int>` (what the compiler accepts for an entry point; `ValueTask` is not one).
const isMainReturn = (returnType: unknown): boolean => /^(?:void|int|Int32|Task|Task<(?:int|Int32)>)$/u.test(compact(typeof returnType === "string" ? returnType : null));

// No parameters or a single `string[]` (`string[] args`, `System.String[]`).
function isMainParameters(parameters: Parameter[]): boolean {
  if (parameters.length === 0) return true;
  const [only] = parameters;
  return parameters.length === 1 && !only!.modifier && /^(?:string|String)\[\]$/u.test(compact(only!.type));
}

const isGeneric = (typeParameters: unknown): boolean => typeof typeParameters === "string" && typeParameters !== "" && typeParameters !== "[]";

function entryPoint(graph: IGraphContributor, fileId: string, handler: GraphNode, handlerName: string): void {
  const line = Number(handler.properties.line);
  const node = {
    id: `${fileId}:entrypoint:${line}:0:main:<none>`,
    label: "EntryPoint" as const,
    properties: { kind: "main", trigger: null, receiverName: null, library: "csharp", line, handlerName },
  };
  graph.addNode(node);
  graph.addRelationship({ from: fileId, to: node.id, type: "DECLARES_ENTRYPOINT", properties: {} });
  graph.addRelationship({ from: node.id, to: handler.id, type: "ENTRYPOINT_HANDLED_BY", properties: {} });
}

// A static `Main` (any visibility, non-generic, in a non-generic type) with a valid signature is run by the runtime,
// and so are a file's top-level statements, whose synthetic `<top-level>` Function is the handler. An instance `Main`
// or one with other parameters is an ordinary method.
export const csharpEntrypointsContributor: ISemanticContributor = {
  id: "csharp.entrypoints",
  contribute(graph) {
    for (const { node, owner, fileId } of csharpMethods(graph)) {
      const properties = node.properties;
      if (properties.name !== "Main" || properties.kind !== "method" || properties.isStatic !== true) continue;
      if (!isMainReturn(properties.returnType) || isGeneric(properties.typeParameters) || isGeneric(owner.properties.typeParameters)) continue;
      let parameters: Parameter[] = [];
      try {
        parameters = typeof properties.parameters === "string" ? JSON.parse(properties.parameters) as Parameter[] : [];
      } catch {
        continue;
      }
      if (!isMainParameters(parameters)) continue;
      entryPoint(graph, fileId, node, "Main");
    }
    for (const rel of graph.relationshipsOfType("DEFINES_FUNCTION")) {
      const file = graph.node(rel.from);
      const fn = graph.node(rel.to);
      if (!file || !fn || file.properties.language !== "csharp" || file.properties.hasTopLevelStatements !== true || fn.properties.name !== "<top-level>") continue;
      entryPoint(graph, file.id, fn, "<top-level>");
    }
  },
};
