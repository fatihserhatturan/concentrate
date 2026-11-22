import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { GraphNode } from "../../../core/graph/model.js";
import type { ResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";

// Track "calls" fills this in: type names of C# code, resolved straight from the graph nodes. A simple name is
// looked up in the enclosing types, the file's namespaces (innermost first, each with the `using`s written
// inside it), the file's usings and global usings, and the namespace index; generic arity and `partialKey` apply.
export type CSharpType = {
  id: string;
  node: GraphNode;
  isInterface: boolean;
  /** Every file that declares the type (more than one for a `partial` type). */
  fileIds: readonly string[];
  name: string;
  qualifiedName: string;
  namespace: string;
  outer: string | null;
};

/** `fileId`: the file the use site is in; `typeId`: the innermost enclosing type, when known. */
export type CSharpTypeScope = { fileId: string; typeId?: string | null; namespace?: string };

export type CSharpTypeIndex = {
  types: readonly CSharpType[];
  byId: ReadonlyMap<string, CSharpType>;
  byQualifiedName(name: string): CSharpType | null;
  /** The type `name` means when written inside `scope`. */
  resolve(name: string, scope: CSharpTypeScope): CSharpType | null;
  /** The type that encloses `type` (null for a top-level type). */
  enclosing(type: CSharpType): CSharpType | null;
  /** Direct supertypes: the base class, then the interfaces (the ones that resolve). */
  supertypes(type: CSharpType): readonly CSharpType[];
  /** Every type that extends or implements `type`, directly or not. */
  subtypes(type: CSharpType): readonly CSharpType[];
};

const emptyTypeIndex: CSharpTypeIndex = {
  types: [],
  byId: new Map(),
  byQualifiedName: () => null,
  resolve: () => null,
  enclosing: () => null,
  supertypes: () => [],
  subtypes: () => [],
};

export function createCSharpTypeIndex(_graph: IGraphContributor, _index: ResolutionRelationshipIndex): CSharpTypeIndex {
  return emptyTypeIndex;
}
