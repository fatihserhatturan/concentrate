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

export async function discoverFiles(rootPath: string): Promise<string[]> {
  const ig = ignore().add(defaultIgnorePatterns);
  await addGitIgnore(rootPath, ig);

  const entries = await fg("**/*", {
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
