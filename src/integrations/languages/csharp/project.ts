import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import { emptyCSharpProjectModel, type CSharpProjectModel } from "./project/types.js";

// What the import resolution step of a scan learns about C# namespaces and hands to the call and inheritance
// resolvers of the same scan (the way Java's import step installs its module filter). One namespace spans many
// files, so a namespace is a name that maps to every file that declares it, and to the types declared in it.
// This phase treats the whole scan as one project.
export type CSharpNamespaceIndex = {
  /** Every namespace that exists in the scan: the declared ones and each of their ancestors (`A` for `A.B.C`). */
  readonly namespaces: readonly string[];
  hasNamespace(namespace: string): boolean;
  /** File node ids of the files that declare `namespace` itself (`File.csharpNamespaces`), not its children. */
  filesOf(namespace: string): readonly string[];
  /** Class and Interface node ids declared directly in `namespace` ("" is the global namespace). */
  typeIdsIn(namespace: string): readonly string[];
};

export const emptyCSharpNamespaceIndex: CSharpNamespaceIndex = {
  namespaces: [],
  hasNamespace: () => false,
  filesOf: () => [],
  typeIdsIn: () => [],
};

const indexes = new WeakMap<object, CSharpNamespaceIndex>();

/** The import resolution step builds the index; the call and inheritance resolvers of the same scan read it back. */
export function setCSharpNamespaceIndex(graph: IGraphContributor | object, index: CSharpNamespaceIndex): void {
  indexes.set(graph, index);
}

export function csharpNamespaceIndexOf(graph: IGraphContributor | object): CSharpNamespaceIndex {
  return indexes.get(graph) ?? emptyCSharpNamespaceIndex;
}

// The project and solution model of the scan, read once by the import resolution step (`readCSharpProjectModel`) and
// handed to the later resolvers of the same scan, like the namespace index. `emptyCSharpProjectModel()` when the scan has no project file.
const projectModels = new WeakMap<object, CSharpProjectModel>();

export function setCSharpProjectModel(graph: IGraphContributor | object, model: CSharpProjectModel): void {
  projectModels.set(graph, model);
}

export function csharpProjectModelOf(graph: IGraphContributor | object): CSharpProjectModel {
  return projectModels.get(graph) ?? emptyCSharpProjectModel();
}
