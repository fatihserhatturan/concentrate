import path from "node:path";

const styleExtensions = [".scss", ".sass", ".css", ".less"];

export function isStyleFile(fileId: string): boolean {
  return styleExtensions.includes(path.posix.extname(fileId.slice("file:".length)).toLowerCase());
}

// The file a style sheet's `@import`, `@use`, `@forward`, `url()` or
// `composes` names, relative to the sheet. Sass and Less add the extension
// and look for a partial (`_name.scss`) and a folder's `_index` / `index`; a
// bare name is tried against the sheet's folder only (load paths and
// `node_modules` are not read).
export function resolveStyleImport(source: string, importerFileId: string, files: ReadonlyMap<string, string>): string | null {
  const importerDirectory = path.posix.dirname(importerFileId.slice("file:".length).split(path.sep).join("/"));
  const base = path.posix.normalize(path.posix.join(importerDirectory, source));
  const directory = path.posix.dirname(base);
  const name = path.posix.basename(base);
  const candidates = [base];
  const known = styleExtensions.includes(path.posix.extname(name).toLowerCase());
  if (!known) {
    for (const extension of styleExtensions) candidates.push(`${base}${extension}`);
  }
  for (const extension of known ? [""] : styleExtensions) candidates.push(path.posix.join(directory, `_${name}${extension}`));
  for (const extension of styleExtensions) {
    candidates.push(path.posix.join(base, `_index${extension}`), path.posix.join(base, `index${extension}`));
  }
  for (const candidate of candidates) {
    const id = files.get(candidate);
    if (id) return id;
  }
  return null;
}
