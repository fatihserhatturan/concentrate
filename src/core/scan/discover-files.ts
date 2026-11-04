import path from "node:path";
import { readFile } from "node:fs/promises";
import { GitIgnore } from "./gitignore.js";
import { createGlobMatcher, walkFiles } from "./glob.js";

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

/**
 * List project files as sorted absolute paths. `include` patterns are globs
 * (`!` negates); `exclude` patterns and `.gitignore` files, including nested
 * ones, use gitignore semantics.
 */
export async function discoverFiles(rootPath: string, options: DiscoverFilesOptions = {}): Promise<string[]> {
  const ignoreRules = new GitIgnore().add(defaultIgnorePatterns);
  if (options.exclude && options.exclude.length > 0) {
    ignoreRules.add(options.exclude);
  }

  const patterns = options.include && options.include.length > 0 ? options.include : ["**/*"];
  const includes = patterns.filter((pattern) => !pattern.startsWith("!")).map(createGlobMatcher);
  const negatedIncludes = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => createGlobMatcher(pattern.slice(1)));

  const entries = await walkFiles(rootPath, {
    enterDirectory: async (directory, entryNames) => {
      if (entryNames.includes(".gitignore")) {
        await addGitIgnore(rootPath, directory, ignoreRules);
      }
      // A Go module's `vendor/` holds copies of its dependencies.
      if (entryNames.includes("go.mod") && entryNames.includes("vendor")) {
        ignoreRules.add("/vendor/", directory);
      }
    },
    accept: (relativePath, isDirectory) => {
      if (ignoreRules.ignores(relativePath, isDirectory)) return false;
      if (isDirectory) return includes.some((include) => include.mayContain(relativePath));
      return includes.some((include) => include.matches(relativePath))
        && !negatedIncludes.some((include) => include.matches(relativePath));
    },
  });

  return entries.map((entry) => path.join(rootPath, entry));
}

async function addGitIgnore(rootPath: string, directory: string, ignoreRules: GitIgnore): Promise<void> {
  try {
    const content = await readFile(path.join(rootPath, directory, ".gitignore"), "utf8");
    ignoreRules.add(content, directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EISDIR") {
      throw error;
    }
  }
}
