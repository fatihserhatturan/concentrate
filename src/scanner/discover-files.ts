import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import { readFile } from "node:fs/promises";

const defaultIgnorePatterns = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "*.min.js",
];

export type DiscoverFilesOptions = {
  include?: string[];
  exclude?: string[];
};

export async function discoverFiles(rootPath: string, options: DiscoverFilesOptions = {}): Promise<string[]> {
  const ig = ignore().add(defaultIgnorePatterns);
  if (options.exclude && options.exclude.length > 0) {
    ig.add(options.exclude);
  }
  await addGitIgnore(rootPath, ig);

  const patterns = options.include && options.include.length > 0 ? options.include : ["**/*"];

  const entries = await fg(patterns, {
    cwd: rootPath,
    dot: true,
    onlyFiles: true,
    absolute: false,
  });

  return entries
    .filter((entry) => !ig.ignores(entry))
    .map((entry) => path.join(rootPath, entry))
    .sort();
}

async function addGitIgnore(rootPath: string, ig: ReturnType<typeof ignore>): Promise<void> {
  try {
    const content = await readFile(path.join(rootPath, ".gitignore"), "utf8");
    ig.add(content);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
}
