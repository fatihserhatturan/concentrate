import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { javaMethods } from "./shared.js";

type Parameter = { name?: string; type?: string | null; varargs?: boolean };

// `String[]`, `java.lang.String[]`, `String...` (the parser keeps the written type and flags varargs).
function isStringArray(parameter: Parameter | undefined): boolean {
  if (!parameter?.type) return false;
  const type = parameter.type.replace(/\s+/gu, "");
  if (parameter.varargs) return /^(?:java\.lang\.)?String(?:\.\.\.|\[\])?$/u.test(type);
  return /^(?:java\.lang\.)?String(?:\[\]|\.\.\.)$/u.test(type);
}

// `public static void main(String[] args)` (or `String... args`) is run by the JVM with no caller:
// an EntryPoint (kind `main`, library `java`) handled by that method. Non-static, non-public,
// non-void and differently typed `main` methods are ordinary methods. Interfaces may declare one too
// (their methods are public).
export const javaEntrypointsContributor: ISemanticContributor = {
  id: "java.entrypoints",
  contribute(graph) {
    for (const { node, owner, fileId } of javaMethods(graph)) {
      const properties = node.properties;
      if (properties.name !== "main" || properties.kind !== "method") continue;
      if (properties.isStatic !== true || properties.visibility !== "public" || properties.returnType !== "void") continue;
      const parameters = typeof properties.parameters === "string" ? JSON.parse(properties.parameters) as Parameter[] : [];
      if (parameters.length !== 1 || !isStringArray(parameters[0])) continue;
      // A local or anonymous class cannot be launched.
      if (owner.properties.nesting === "local" || owner.properties.nesting === "anonymous") continue;
      const line = Number(properties.line);
      const entrypoint = {
        id: `${fileId}:entrypoint:${line}:0:main:<none>`,
        label: "EntryPoint" as const,
        properties: { kind: "main", trigger: null, receiverName: null, library: "java", line, handlerName: "main" },
      };
      graph.addNode(entrypoint);
      graph.addRelationship({ from: fileId, to: entrypoint.id, type: "DECLARES_ENTRYPOINT", properties: {} });
      graph.addRelationship({ from: entrypoint.id, to: node.id, type: "ENTRYPOINT_HANDLED_BY", properties: {} });
    }
  },
};
