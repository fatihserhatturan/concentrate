import type { ILanguageCallResolver, ILanguageInheritanceResolver } from "../../../core/contracts/call-resolver.js";
import { isPythonFile } from "../file-kind.js";
import { createPythonCallIndex, resolvePythonCall } from "./calls.js";
import { addPythonInheritanceRelationships } from "./inheritance.js";

// Python calls through import bindings, `self` and class hierarchies; bases
// are looked up through import bindings and re-exports, not the default lookup.
export const pythonCallResolver: ILanguageCallResolver = {
  id: "python",
  supports: isPythonFile,
  createSession(graph, index) {
    const pythonIndex = createPythonCallIndex(graph, index);
    return (call, callerFileId, callerFunctionId) => resolvePythonCall(call, callerFileId, callerFunctionId, pythonIndex);
  },
};

export const pythonInheritanceResolver: ILanguageInheritanceResolver = {
  id: "python",
  ownsClassesIn: isPythonFile,
  addRelationships(graph, context) {
    addPythonInheritanceRelationships(graph, context.index, context.classesByFileAndName, context.interfacesByFileAndName, context.importsByFile);
  },
};
