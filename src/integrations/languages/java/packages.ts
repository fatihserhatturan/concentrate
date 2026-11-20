import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { JavaModuleFilter } from "./module-visibility.js";
import { JavaSourceRoots } from "./source-roots.js";

// The package index of a scan: which files declare which package and which file declares which type.
// Built from `File.packageName` and the `qualifiedName` of Class/Interface nodes, so it needs no parsing.
// Import resolution uses it; the call resolver can reuse the same lookups.

/** Packages whose imports are never project files (JDK and Jakarta EE). */
const PLATFORM_PREFIXES = ["java.", "javax.", "jakarta."];

export function isJavaPlatformPackage(name: string): boolean {
  return PLATFORM_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The `source`/`isWildcard`/`isStatic` properties of an `Import` node. */
export type JavaImportShape = { source: string; isWildcard: boolean; isStatic: boolean };

/** Files an import reaches; `expected` is whether failing to find any counts as unresolved. */
export type JavaImportTarget = { fileIds: readonly string[]; expected: boolean };

export interface JavaPackageIndex {
  readonly sourceRoots: JavaSourceRoots;
  /** Files declaring this package (package-info/module-info excluded), in scan order. */
  packageFiles(packageName: string): readonly string[];
  hasPackage(packageName: string): boolean;
  /** The file declaring this qualified type name (`com.acme.Outer.Inner` -> Outer's file). */
  typeFile(qualifiedName: string): string | undefined;
  /** Qualified names of the types a file declares, nested ones included. */
  typesOfFile(fileId: string): readonly string[];
  /** The package a file declares ("" for the default package). */
  packageOfFile(fileId: string): string | undefined;
  /** The qualified name of `name` (simple or `Outer.Inner`) in a package: same package needs no import. */
  typeInPackage(packageName: string, name: string): string | undefined;
  /** Longest prefix of a dotted name that is a known type: `a.b.C.m` -> `a.b.C`. */
  longestTypePrefix(dotted: string): string | undefined;
  /** Where an import points. */
  /** `fromFile` (the importer) lets the module filter prefer the files it sees. */
  resolveImport(shape: JavaImportShape, fromFile?: string): JavaImportTarget;
}

export type JavaPackageIndexOptions = {
  /** Extra source roots, for example from a build file. */
  extraSourceRoots?: Iterable<string>;
  /** Keeps the candidates of the modules the importer sees (Maven/Gradle). */
  moduleFilter?: JavaModuleFilter;
};

export function buildJavaPackageIndex(
  graph: Pick<IGraphContributor, "nodesWithLabel" | "relationshipsOfType">,
  options: JavaPackageIndexOptions = {},
): JavaPackageIndex {
  const sourceRoots = new JavaSourceRoots();
  for (const root of options.extraSourceRoots ?? []) sourceRoots.addRoot(root);

  const filesByPackage = new Map<string, string[]>();
  const packageByFile = new Map<string, string>();
  for (const node of graph.nodesWithLabel("File")) {
    if (node.properties.language !== "java") continue;
    const packageName = typeof node.properties.packageName === "string" ? node.properties.packageName : "";
    packageByFile.set(node.id, packageName);
    if (typeof node.properties.relativePath === "string") {
      sourceRoots.rootOf(node.properties.relativePath.split("\\").join("/"), packageName || undefined);
    }
    if (node.properties.javaFileKind) continue;
    const files = filesByPackage.get(packageName) ?? [];
    files.push(node.id);
    filesByPackage.set(packageName, files);
  }

  const typeFiles = new Map<string, string>();
  const allTypeFiles = new Map<string, string[]>();
  const typesByFile = new Map<string, string[]>();
  const typeNodes = new Map<string, { qualifiedName: string; nesting: unknown }>();
  for (const label of ["Class", "Interface"] as const) {
    for (const node of graph.nodesWithLabel(label)) {
      if (typeof node.properties.qualifiedName === "string") {
        typeNodes.set(node.id, { qualifiedName: node.properties.qualifiedName, nesting: node.properties.nesting });
      }
    }
  }
  for (const type of ["DEFINES_CLASS", "DEFINES_INTERFACE"] as const) {
    for (const relationship of graph.relationshipsOfType(type)) {
      const found = typeNodes.get(relationship.to);
      if (found === undefined || !packageByFile.has(relationship.from)) continue;
      // Local and anonymous classes cannot be imported or named from another file.
      if (found.nesting === "local" || found.nesting === "anonymous") continue;
      if (!typeFiles.has(found.qualifiedName)) typeFiles.set(found.qualifiedName, relationship.from);
      const declaring = allTypeFiles.get(found.qualifiedName) ?? [];
      if (!declaring.includes(relationship.from)) declaring.push(relationship.from);
      allTypeFiles.set(found.qualifiedName, declaring);
      const names = typesByFile.get(relationship.from) ?? [];
      names.push(found.qualifiedName);
      typesByFile.set(relationship.from, names);
    }
  }

  const longestTypePrefix = (dotted: string): string | undefined => {
    let candidate = dotted;
    for (;;) {
      if (typeFiles.has(candidate)) return candidate;
      const dot = candidate.lastIndexOf(".");
      if (dot < 0) return undefined;
      candidate = candidate.slice(0, dot);
    }
  };

  return {
    sourceRoots,
    packageFiles: (packageName) => filesByPackage.get(packageName) ?? [],
    hasPackage: (packageName) => filesByPackage.has(packageName),
    typeFile: (qualifiedName) => typeFiles.get(qualifiedName),
    typesOfFile: (fileId) => typesByFile.get(fileId) ?? [],
    packageOfFile: (fileId) => packageByFile.get(fileId),
    typeInPackage(packageName, name) {
      const qualified = packageName ? `${packageName}.${name}` : name;
      return typeFiles.has(qualified) ? qualified : undefined;
    },
    longestTypePrefix,
    resolveImport({ source, isWildcard, isStatic }, fromFile) {
      const filter = options.moduleFilter;
      const visible = (files: readonly string[]): readonly string[] => (filter && fromFile !== undefined ? filter(fromFile, files) : files);
      if (isJavaPlatformPackage(source)) return { fileIds: [], expected: false };
      // `import a.b.*` is the package a.b: every file, like a Go package import.
      if (isWildcard && !isStatic && filesByPackage.has(source)) return { fileIds: visible(filesByPackage.get(source)!), expected: true };
      // Anything else names a type, with a member (static) or nested types possibly after it.
      const type = longestTypePrefix(source);
      if (type !== undefined) {
        const first = typeFiles.get(type)!;
        const seen = visible(allTypeFiles.get(type) ?? [first]);
        // No visible declaration: the first one, as without a build model.
        return { fileIds: [seen.includes(first) ? first : seen[0] ?? first], expected: true };
      }
      // A project package missing the type counts as unresolved; a foreign package is external.
      const lastDot = source.lastIndexOf(".");
      const owner = isWildcard ? source : lastDot < 0 ? "" : source.slice(0, lastDot);
      return { fileIds: [], expected: filesByPackage.has(owner) };
    },
  };
}
