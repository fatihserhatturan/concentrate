import path from "node:path";

export function isProtoFile(fileId: string): boolean {
  return fileId.endsWith(".proto");
}

// The file a `.proto` import names. Imports are relative to include roots the
// scan does not know (`-I`, buf modules), so: next to the importing file, then
// from the scan root, then the one file whose path ends with the import path
// (the closest to the importer when several do). Well-known imports
// (`google/protobuf/empty.proto`) are not files of the project and stay
// unresolved without counting.
export function resolveProtoImport(source: string, importerFileId: string, files: ReadonlyMap<string, string>): string | null {
  const importer = importerFileId.slice("file:".length).split(path.sep).join("/");
  const directory = path.posix.dirname(importer);
  const beside = files.get(path.posix.normalize(path.posix.join(directory, source)));
  if (beside) return beside;
  const root = files.get(path.posix.normalize(source));
  if (root) return root;
  let best: { id: string; shared: number } | null = null;
  for (const [relative, id] of files) {
    if (!relative.endsWith(`/${source}`)) continue;
    const shared = commonPrefix(path.posix.dirname(relative), directory);
    if (!best || shared > best.shared) best = { id, shared };
  }
  return best?.id ?? null;
}

function commonPrefix(left: string, right: string): number {
  const a = left.split("/");
  const b = right.split("/");
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  return shared;
}
