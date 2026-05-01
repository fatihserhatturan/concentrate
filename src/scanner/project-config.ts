import { readFile } from "node:fs/promises";
import path from "node:path";
import { GraphBuilder } from "../graph/builder.js";

export async function addProjectConfigNodes(
  graph: GraphBuilder,
  repoNodeId: string,
  rootPath: string,
): Promise<void> {
  await Promise.all([
    addJsonConfigValues(graph, repoNodeId, path.join(rootPath, "package.json"), "package.json", [
      "name",
      "version",
      "type",
      "main",
      "module",
      "types",
    ]),
    addJsonConfigValues(graph, repoNodeId, path.join(rootPath, "tsconfig.json"), "tsconfig.json", [
      "compilerOptions.target",
      "compilerOptions.module",
      "compilerOptions.baseUrl",
      "compilerOptions.outDir",
      "compilerOptions.rootDir",
    ]),
  ]);
}

async function addJsonConfigValues(
  graph: GraphBuilder,
  repoNodeId: string,
  filePath: string,
  source: string,
  keys: string[],
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    return;
  }

  for (const key of keys) {
    const value = getPathValue(parsed, key);
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      continue;
    }

    const node = {
      id: `config:${source}:${key}`,
      label: "ConfigValue" as const,
      properties: {
        name: `${source}:${key}`,
        value: String(value),
        valueType: typeof value,
        line: 0,
      },
    };

    graph.addNode(node);
    graph.addRelationship({
      from: repoNodeId,
      to: node.id,
      type: "DECLARES_CONFIG",
      properties: {},
    });
  }
}

function getPathValue(value: unknown, keyPath: string): unknown {
  return keyPath.split(".").reduce((current: unknown, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, value);
}
