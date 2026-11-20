import type { ILanguageCallResolver, ILanguageInheritanceResolver } from "../../../core/contracts/call-resolver.js";
import { isJavaFile } from "../file-kind.js";
import { createJavaCallSession } from "./call-resolver.js";
import { addJavaInheritanceRelationships } from "./inheritance.js";

// Java calls through typed receivers, static and on-demand imports, overloads
// by argument count and interface or override dispatch; bases are looked up by
// package, import and nesting, not by the default name lookup.
export const javaCallResolver: ILanguageCallResolver = {
  id: "java",
  supports: isJavaFile,
  createSession: createJavaCallSession,
};

export const javaInheritanceResolver: ILanguageInheritanceResolver = {
  id: "java",
  ownsClassesIn: isJavaFile,
  addRelationships(graph, context) {
    addJavaInheritanceRelationships(graph, context.index);
  },
};
