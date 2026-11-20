import path from "node:path";

// Java source roots: the directories whose subdirectories mirror package names. Kept apart from the
// package index so a build-system reader (Maven, Gradle: Phase 40) can add the roots it knows.

// `x/src/main/java/com/acme/Foo.java` -> `x/src/main/java`; also `src/test/java`, `src/integrationTest/java`.
// The first `src/<set>/java` triple wins. Null when the path has no conventional layout.
export function conventionalJavaSourceRoot(relativePath: string): string | null {
  const parts = relativePath.split("/");
  for (let i = 0; i + 2 < parts.length; i += 1) {
    if (parts[i] === "src" && parts[i + 2] === "java") return parts.slice(0, i + 3).join("/");
  }
  return null;
}

// File `x/y/com/acme/Foo.java` with `package com.acme` -> `x/y`. Null when the directory does not end
// with the package path. A file in the default package has its own directory as root.
export function inferredJavaSourceRoot(relativePath: string, packageName: string | undefined): string | null {
  const dir = path.posix.dirname(relativePath);
  if (!packageName) return dir;
  const packageDir = packageName.split(".").join("/");
  if (dir === packageDir) return ".";
  return dir.endsWith(`/${packageDir}`) ? dir.slice(0, dir.length - packageDir.length - 1) : null;
}

/**
 * The source roots of a scan. Roots come from `addRoot` (a build file's declared source dirs), from the
 * `src/<set>/java` convention and, for files outside both, from the package path.
 */
export class JavaSourceRoots {
  private readonly declared = new Set<string>();
  private readonly found = new Set<string>();

  /** Register a root the build system declares (posix path relative to the scan root, "." for the root). */
  addRoot(root: string): void {
    this.declared.add(path.posix.normalize(root).replace(/(.)\/$/u, "$1"));
  }

  /**
   * The root of a file: the longest declared root containing it, else the convention, else the one the
   * package path implies; null when none fits.
   */
  rootOf(relativePath: string, packageName: string | undefined): string | null {
    let declared: string | null = null;
    for (const root of this.declared) {
      const inside = root === "." || relativePath.startsWith(`${root}/`);
      if (inside && (declared === null || root.length > declared.length)) declared = root;
    }
    const root = declared ?? conventionalJavaSourceRoot(relativePath) ?? inferredJavaSourceRoot(relativePath, packageName);
    if (root !== null) this.found.add(root);
    return root;
  }

  /** Every root any file resolved to (and every declared one), sorted. */
  all(): string[] {
    return [...new Set([...this.declared, ...this.found])].sort();
  }
}
