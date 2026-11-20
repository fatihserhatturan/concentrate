import type { ILanguageCallResolver, ILanguageInheritanceResolver } from "../../../core/contracts/call-resolver.js";
import { isGoFile } from "../file-kind.js";
import { addGoImplementsRelationships, createGoCallIndex, resolveGoCall } from "./calls.js";

// Go calls (package-qualified, methods through value and interface types) and
// the implicit IMPLEMENTS of a type whose methods satisfy an interface.
export const goCallResolver: ILanguageCallResolver = {
  id: "go",
  supports: isGoFile,
  createSession(graph, index) {
    const goIndex = createGoCallIndex(graph, index);
    return (call, callerFileId) => resolveGoCall(call, callerFileId, goIndex);
  },
};

export const goInheritanceResolver: ILanguageInheritanceResolver = {
  id: "go",
  addRelationships(graph, context) {
    addGoImplementsRelationships(graph, context.index);
  },
};
