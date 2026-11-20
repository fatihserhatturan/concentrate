import { readFile } from "node:fs/promises";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { createDefaultCoreIntegrationRegistry } from "../../src/composition/default-registry.js";
import type { CoreIntegrationRegistry } from "../../src/core/integrations/registry.js";
import type { ILanguageCallResolver } from "../../src/core/contracts/call-resolver.js";
import type { LanguageDescriptor } from "../../src/core/contracts/language-descriptor.js";
import type { ILanguageParser } from "../../src/core/contracts/language-parser.js";
import type { IUnusedExportRules } from "../../src/core/contracts/unused-rules.js";
import type { GraphNode, GraphRelationship } from "../../src/core/graph/model.js";

// A language added entirely outside src/core: `fn name` declares a function,
// `call name` calls one. Also a registry module: workers import this file and
// call createRegistry().

export const toyDescriptor: LanguageDescriptor = { id: "toy", code: true, extensions: [".toy"] };

export function createToyParser(version?: string): ILanguageParser {
  return {
    language: "toy",
    ...(version ? { version } : {}),
    async parse(rootPath, filePath) {
      const relativePath = path.relative(rootPath, filePath);
      const fileNodeId = `file:${relativePath}`;
      // Which thread parsed the file shows in the graph.
      const nodes: GraphNode[] = [{ id: fileNodeId, label: "File", properties: { path: filePath, relativePath, language: "toy", parsedIn: isMainThread ? "main" : "worker" } }];
      const relationships: GraphRelationship[] = [];
      let currentFunction: string | null = null;
      const lines = (await readFile(filePath, "utf8")).split("\n");
      lines.forEach((text, index) => {
        const [keyword, name] = text.trim().split(/\s+/u);
        if (keyword === "fn" && name) {
          const id = `${fileNodeId}:function:${name}`;
          nodes.push({ id, label: "Function", properties: { name, qualifiedName: name, line: index + 1 } });
          relationships.push({ from: fileNodeId, to: id, type: "DEFINES_FUNCTION", properties: {} });
          currentFunction = id;
        } else if (keyword === "call" && name && currentFunction) {
          const id = `${currentFunction}:call:${index + 1}:${name}`;
          nodes.push({ id, label: "Call", properties: { name, expression: name, callee: name, receiver: null, line: index + 1, columnNumber: 0 } });
          relationships.push({ from: currentFunction, to: id, type: "CALLS", properties: {} });
        }
      });
      return { fileNodeId, nodes, relationships };
    },
  };
}

export const toyCallResolver: ILanguageCallResolver = {
  id: "toy",
  supports: (fileId) => fileId.endsWith(".toy"),
  createSession(graph) {
    const byName = new Map(graph.nodesWithLabel("Function").map((node) => [String(node.properties.name), node.id]));
    return (call) => {
      const target = byName.get(String(call.properties.callee));
      return target ? [{ functionId: target }] : [];
    };
  },
};

export function createToyRegistry(version?: string): CoreIntegrationRegistry {
  const registry = createDefaultCoreIntegrationRegistry();
  registry.registerLanguage(toyDescriptor);
  registry.registerLanguageParser(createToyParser(version));
  registry.registerCallResolver(toyCallResolver);
  registry.registerUnusedExportRules(toyUnusedRules);
  return registry;
}

export function createRegistry(): CoreIntegrationRegistry {
  return createToyRegistry();
}

export const toyUnusedRules: IUnusedExportRules = {
  id: "toy",
  languages: ["toy"],
  supports: (file) => file.endsWith(".toy"),
  note: "Toy: every function counts as public API.",
};
