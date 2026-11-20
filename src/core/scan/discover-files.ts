import path from "node:path";
import type { IFileSystem } from "../contracts/file-system.js";
import type { FileConventions } from "../contracts/language-descriptor.js";
import { GitIgnore } from "./gitignore.js";
import { createGlobMatcher, walkFiles } from "./glob.js";

const defaultIgnorePatterns = [
  ".git",
  // The graph, parse cache and manifest of Concentrate itself.
  ".concentrate",
  "dist",
  "build",
  "coverage",
  ".cache",
];

export type DiscoverFilesOptions = {
  include?: string[];
  exclude?: string[];
  /** The languages' ignore rules (`node_modules`, Go's `vendor/`); without them only the generic defaults apply. */
  conventions?: Pick<FileConventions, "ignoredPatterns" | "ignoredInDirectory">;
};

/**
 * List project files as sorted absolute paths. `include` patterns are globs
 * (`!` negates); `exclude` patterns and `.gitignore` files, including nested
 * ones, use gitignore semantics.
 */
export async function discoverFiles(rootPath: string, fileSystem: IFileSystem, options: DiscoverFilesOptions = {}): Promise<string[]> {
  const ignoreRules = new GitIgnore().add([...defaultIgnorePatterns, ...options.conventions?.ignoredPatterns ?? []]);
  if (options.exclude && options.exclude.length > 0) {
    ignoreRules.add(options.exclude);
  }

  const patterns = options.include && options.include.length > 0 ? options.include : ["**/*"];
  const includes = patterns.filter((pattern) => !pattern.startsWith("!")).map(createGlobMatcher);
  const negatedIncludes = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => createGlobMatcher(pattern.slice(1)));

  // A folder of several clones (no `.git` of its own) is scanned as a whole; the rule is for a repository that holds copies of itself.
  const rootIsRepository = await fileSystem.exists(path.join(rootPath, ".git"));
  // `include` patterns that name a path inside a nested repository bring it back.
  const explicit = options.include && options.include.length > 0 ? includes : [];
  const broughtBack = (directory: string) =>
    explicit.some((include) => include.pattern === directory || include.pattern.startsWith(`${directory}/`));

  const entries = await walkFiles(rootPath, fileSystem, {
    enterDirectory: async (directory, entryNames) => {
      if (entryNames.includes(".gitignore")) {
        await addGitIgnore(rootPath, directory, ignoreRules, fileSystem);
      }
      for (const pattern of options.conventions?.ignoredInDirectory(entryNames) ?? []) ignoreRules.add(pattern, directory);
    },
    accept: async (relativePath, isDirectory) => {
      if (ignoreRules.ignores(relativePath, isDirectory)) return false;
      if (isDirectory && rootIsRepository && await isNestedRepository(rootPath, relativePath, fileSystem) && !broughtBack(relativePath)) return false;
      if (isDirectory) return includes.some((include) => include.mayContain(relativePath));
      return includes.some((include) => include.matches(relativePath))
        && !negatedIncludes.some((include) => include.matches(relativePath));
    },
  });

  return entries.map((entry) => path.join(rootPath, entry));
}

/**
 * Inside a repository, a subdirectory with a `.git` file or directory of its
 * own is a worktree, submodule or clone: another copy of code, not part of
 * this project.
 */
function isNestedRepository(rootPath: string, relativeDirectory: string, fileSystem: IFileSystem): Promise<boolean> {
  return fileSystem.exists(path.join(rootPath, relativeDirectory, ".git"));
}

async function addGitIgnore(rootPath: string, directory: string, ignoreRules: GitIgnore, fileSystem: IFileSystem): Promise<void> {
  try {
    const content = await fileSystem.readTextFile(path.join(rootPath, directory, ".gitignore"));
    ignoreRules.add(content, directory);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT" && code !== "EISDIR") {
      throw error;
    }
  }
}
