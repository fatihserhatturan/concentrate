import type { ILanguageCallResolver, ILanguageInheritanceResolver } from "../../../core/contracts/call-resolver.js";
import { isCSharpFile } from "../file-kind.js";
import { createCSharpCallSession } from "./call-resolver.js";
import { addCSharpInheritanceRelationships } from "./inheritance.js";

// C# calls and bases go through namespaces and usings, not through the default name lookup.
export const csharpCallResolver: ILanguageCallResolver = {
  id: "csharp",
  supports: isCSharpFile,
  createSession: createCSharpCallSession,
};

export const csharpInheritanceResolver: ILanguageInheritanceResolver = {
  id: "csharp",
  ownsClassesIn: isCSharpFile,
  addRelationships(graph, context) {
    addCSharpInheritanceRelationships(graph, context.index);
  },
};
