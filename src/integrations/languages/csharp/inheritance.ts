import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { ResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";

// Track "calls" fills this in: C# type hierarchy, read from `Class.bases` / `Interface.bases` (the raw base list
// in order; the first entry of a class is the base class or an interface) and looked up through `types.ts`:
//   class A : B, I        A EXTENDS B (B a class), A IMPLEMENTS I (I an interface)
//   struct S : I          S IMPLEMENTS I
// `partial` types merge the base lists of every declaration (`File.csharpPartials`). A base outside the scan adds nothing.
export function addCSharpInheritanceRelationships(_graph: IGraphContributor, _index: ResolutionRelationshipIndex): void {
  // Stub: no relationships yet.
}
