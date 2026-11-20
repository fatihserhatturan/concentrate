import { javaModuleKey, moduleOfFile, visibleModules, type JavaBuildModel } from "./build/index.js";

// Which Java files a file can see through its module's dependencies (Maven, Gradle). A filter takes the
// requesting file and candidate files that declare the same name; it keeps the candidates of modules the
// requester sees, or all of them when none is visible (the build file may be incomplete). Files outside
// every module are never filtered.
export type JavaModuleFilter = (fromFileId: string, candidateFileIds: readonly string[]) => readonly string[];

export function createJavaModuleFilter(model: JavaBuildModel, relativePathByFileId: ReadonlyMap<string, string>): JavaModuleFilter | null {
  if (model.modules.length === 0) return null;
  const moduleByFile = new Map<string, string | null>();
  const keyOf = (fileId: string): string | null => {
    let key = moduleByFile.get(fileId);
    if (key === undefined) {
      const relative = relativePathByFileId.get(fileId);
      const module = relative === undefined ? undefined : moduleOfFile(model, relative);
      key = module ? javaModuleKey(module) : null;
      moduleByFile.set(fileId, key);
    }
    return key;
  };
  const visibleCache = new Map<string, Set<string>>();
  return (fromFileId, candidates) => {
    if (candidates.length < 2) return candidates;
    const from = keyOf(fromFileId);
    if (from === null) return candidates;
    let visible = visibleCache.get(from);
    if (!visible) visibleCache.set(from, (visible = visibleModules(model, from)));
    const seen = visible;
    const kept = candidates.filter((id) => {
      const key = keyOf(id);
      return key !== null && seen.has(key);
    });
    return kept.length > 0 ? kept : candidates;
  };
}

// The import resolution step builds the filter; the call resolver of the same scan reads it back.
const filters = new WeakMap<object, JavaModuleFilter>();

export function setJavaModuleFilter(graph: object, filter: JavaModuleFilter | null): void {
  if (filter) filters.set(graph, filter);
  else filters.delete(graph);
}

export function javaModuleFilterOf(graph: object): JavaModuleFilter | undefined {
  return filters.get(graph);
}
