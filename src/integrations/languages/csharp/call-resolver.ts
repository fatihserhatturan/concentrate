import type { CallResolutionSession } from "../../../core/contracts/call-resolver.js";
import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { ResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";

// Track "calls" fills this in: calls through typed receivers (locals, parameters, fields, properties, `this`, `base`,
// `new T()`, target-typed `new()`), static and qualified calls, `using static` members, extension methods on their
// receiver type, interface and virtual/override dispatch (marked with `via`), overloads by argument count (ambiguous
// ones are counted, not guessed).
export function createCSharpCallSession(_graph: IGraphContributor, _index: ResolutionRelationshipIndex): CallResolutionSession {
  return () => [];
}
