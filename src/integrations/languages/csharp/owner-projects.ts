import type { CSharpProject, CSharpProjectModel } from "./project/types.js";

// Of several projects in one directory only the first by file path (plain code-unit order) owns the directory's files
// (a Package is keyed by its directory); the others own nothing. The single source of this rule: the manifest
// (`declaredCSharpProjects`), entrypoints (CS7022), the projects contributor and namespace scoping all use it.
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

// `unresolvedReferences` is the count of ProjectReferences the project reader could not expand or find.
export function hasUnresolvedReferences(project: CSharpProject): boolean {
  return project.unresolvedReferences > 0;
}
