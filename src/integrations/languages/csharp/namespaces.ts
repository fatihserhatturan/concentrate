import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import { emptyCSharpNamespaceIndex, type CSharpNamespaceIndex } from "./project.js";

// Track "imports" fills this in: the namespace index of the scan, built from `File.csharpNamespaces` and the
// `namespace` of every Class and Interface node (a `partial` type is one node).
export function buildCSharpNamespaceIndex(_graph: IGraphContributor): CSharpNamespaceIndex {
  return emptyCSharpNamespaceIndex;
}
