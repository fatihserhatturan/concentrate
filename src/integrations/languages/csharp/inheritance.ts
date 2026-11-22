import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { ResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { createCSharpTypeIndex } from "./types.js";

// C# type hierarchy, read from `Class.bases` (the raw base list in order; the first entry of a class is the base
// class or an interface, resolution decides) and looked up through `types.ts`:
//   class A : B, I        A EXTENDS B (B a class), A IMPLEMENTS I (I an interface)
//   struct S : I          S IMPLEMENTS I
//   record R : P          R EXTENDS P
// `partial` types have the base lists of every declaration merged (`File.csharpPartials`, done by `types.ts`), each
// base resolved in the file that wrote it. A base outside the scan adds nothing. `interface I : J` has no edge:
// EXTENDS is Class to Class in the graph schema; the call resolver reads the interface's bases itself
// (`CSharpTypeIndex.supertypes`).
export function addCSharpInheritanceRelationships(graph: IGraphContributor, index: ResolutionRelationshipIndex): void {
  const types = createCSharpTypeIndex(graph, index);
  const declared = new Set<string>();
  for (const type of types.types) {
    if (type.isInterface || type.kind === "enum" || type.kind === "delegate") continue;
    for (const target of types.supertypes(type)) {
      const relationship = target.isInterface ? "IMPLEMENTS" : "EXTENDS";
      // A struct has no base class, and only the first class of a list can be one.
      if (relationship === "EXTENDS" && (type.kind === "struct" || type.kind === "record struct")) continue;
      const key = `${type.id}\0${target.id}\0${relationship}`;
      if (declared.has(key)) continue;
      declared.add(key);
      graph.addRelationship({ from: type.id, to: target.id, type: relationship, properties: {} });
    }
  }
}
