import type { ILanguageCallResolver, ILanguageInheritanceResolver } from "../../../core/contracts/call-resolver.js";
import { isCppFile } from "../file-kind.js";
import { addCppRelationships, cppIndexFor, resolveCppCall } from "./calls.js";

// C and C++ calls (namespaces, classes, virtual dispatch, header declarations
// linked to their definitions) and C++ class inheritance.
export const cppCallResolver: ILanguageCallResolver = {
  id: "cpp",
  supports: isCppFile,
  createSession(graph, index) {
    const cppIndex = cppIndexFor(graph, index);
    return (call, callerFileId, callerFunctionId) => resolveCppCall(call, callerFileId, callerFunctionId, cppIndex);
  },
};

export const cppInheritanceResolver: ILanguageInheritanceResolver = {
  id: "cpp",
  addRelationships(graph, context) {
    addCppRelationships(graph, context.index);
  },
};
