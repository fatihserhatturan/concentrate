import type { CSharpProject, CSharpProjectModel } from "./project/types.js";

// Of several projects in one directory only the first by file path (plain code-unit order) owns the directory's files
// (a Package is keyed by its directory); the others own nothing. Same rule as `declaredCSharpProjects` (manifest.ts),
// so namespace scoping and the manifest agree on which project a file belongs to.
export function ownerProjects(model: CSharpProjectModel): CSharpProject[] {
  const kept: CSharpProject[] = [];
  const dirs = new Set<string>();
  for (const project of [...model.projects].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    if (dirs.has(project.dir)) continue;
    dirs.add(project.dir);
    kept.push(project);
  }
  return kept;
}

// `unresolvedReferences` is set by the project reader (count of ProjectReferences it could not expand or find).
// Read defensively so this file does not depend on the field's presence.
export function hasUnresolvedReferences(project: CSharpProject): boolean {
  return ((project as { unresolvedReferences?: number }).unresolvedReferences ?? 0) > 0;
}
