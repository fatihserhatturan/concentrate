import type { ILanguageCallResolver, ILanguageInheritanceResolver } from "../../../core/contracts/call-resolver.js";
import { isRustFile } from "../file-kind.js";
import { createRustCallIndex, resolveRustCall } from "./calls.js";

// Rust calls (paths, methods by receiver type, traits).
export const rustCallResolver: ILanguageCallResolver = {
  id: "rust",
  supports: isRustFile,
  createSession(graph, index) {
    const rustIndex = createRustCallIndex(graph, index);
    return (call, callerFileId, callerFunctionId) => resolveRustCall(call, callerFileId, callerFunctionId, rustIndex);
  },
};

// `impl Trait for Type` blocks the parser recorded on the file (the type and
// the trait may live in other files, found through its `use`s).
export const rustInheritanceResolver: ILanguageInheritanceResolver = {
  id: "rust",
  addRelationships(graph, context) {
    for (const node of graph.nodesWithLabel("File")) {
      if (typeof node.properties.rustImpls !== "string") continue;
      const impls = JSON.parse(node.properties.rustImpls) as Array<{ type: string; trait: string }>;
      delete node.properties.rustImpls;
      const seen = new Set<string>();
      for (const impl of impls) {
        const classId = context.resolveNamedNode(impl.type, node.id, context.classesByFileAndName);
        const traitId = context.resolveNamedNode(impl.trait, node.id, context.interfacesByFileAndName);
        if (classId && traitId && !seen.has(`${classId}\0${traitId}`)) {
          seen.add(`${classId}\0${traitId}`);
          graph.addRelationship({ from: classId, to: traitId, type: "IMPLEMENTS", properties: {} });
        }
      }
    }
  },
};
