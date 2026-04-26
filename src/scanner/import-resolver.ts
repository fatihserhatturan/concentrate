import path from "node:path";
import { readFile } from "node:fs/promises";
import { GraphBuilder } from "../graph/builder.js";
import type { GraphNode, GraphRelationship } from "../graph/model.js";

const importTargetExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py"];
const jsRuntimeExtensions = [".js", ".jsx", ".mjs", ".cjs"];
const absoluteModuleLanguages = new Set(["python"]);

type JsTsResolutionConfig = {
  baseUrl: string | null;
  paths: JsTsPathMapping[];
  packageJson: JsTsPackageJsonResolutionConfig | null;
};

type JsTsPathMapping = {
  pattern: string;
  targets: string[];
};

type JsTsPackageJsonResolutionConfig = {
  name: string | null;
  main: string | null;
  types: string | null;
  exports: unknown;
};

type GoResolutionConfig = {
  moduleName: string | null;
};

export async function addImportResolutionRelationships(graph: GraphBuilder, rootPath: string): Promise<{
  resolved: number;
  unresolved: number;
}> {
  const fileIdByRelativePath = createFileIndex(graph.nodes);
  const importerFileIdByImportId = createImporterIndex(graph.relationships);
  const jsTsConfig = await readJsTsResolutionConfig(rootPath);
  const goConfig = await readGoResolutionConfig(rootPath);
  let resolved = 0;
  let unresolved = 0;

  for (const node of graph.nodes) {
    if (node.label !== "Import") {
      continue;
    }

    const source = node.properties.source;
    if (typeof source !== "string") {
      continue;
    }

    const importerFileId = importerFileIdByImportId.get(node.id);
    if (!importerFileId || !shouldAttemptResolution(source, importerFileId, jsTsConfig, goConfig)) {
      continue;
    }

    const targetFileId = resolveImport(source, importerFileId, fileIdByRelativePath, jsTsConfig, goConfig);

    if (!targetFileId) {
      unresolved += 1;
      continue;
    }

    graph.addRelationship({
      from: node.id,
      to: targetFileId,
      type: "RESOLVES_TO",
      properties: {},
    });
    resolved += 1;
  }

  return { resolved, unresolved };
}

function shouldAttemptResolution(
  source: string,
  importerFileId: string,
  jsTsConfig: JsTsResolutionConfig,
  goConfig: GoResolutionConfig,
): boolean {
  if (source.startsWith(".")) {
    return true;
  }

  if (isJsTsFile(importerFileId)) {
    return createJsTsConfiguredImportBasePaths(source, jsTsConfig).length > 0;
  }

  if (isGoFile(importerFileId) && goConfig.moduleName) {
    return source.startsWith(`${goConfig.moduleName}/`);
  }

  if (isRustFile(importerFileId)) {
    return source.startsWith("crate::") || source.startsWith("super::") || !source.includes("::");
  }

  return shouldResolveAbsoluteImport(importerFileId);
}

function createImporterIndex(relationships: GraphRelationship[]): Map<string, string> {
  const importerFileIdByImportId = new Map<string, string>();

  for (const relationship of relationships) {
    if (relationship.type === "IMPORTS") {
      importerFileIdByImportId.set(relationship.to, relationship.from);
    }
  }

  return importerFileIdByImportId;
}

function createFileIndex(nodes: GraphNode[]): Map<string, string> {
  const index = new Map<string, string>();

  for (const node of nodes) {
    if (node.label !== "File") {
      continue;
    }

    const relativePath = node.properties.relativePath;
    if (typeof relativePath === "string") {
      index.set(toPosixPath(relativePath), node.id);
    }
  }

  return index;
}

function resolveImport(
  source: string,
  importerFileId: string,
  fileIdByRelativePath: Map<string, string>,
  jsTsConfig: JsTsResolutionConfig,
  goConfig: GoResolutionConfig,
): string | null {
  if (!source.startsWith(".")) {
    return resolveAbsoluteImport(source, importerFileId, fileIdByRelativePath, jsTsConfig, goConfig);
  }

  const importerRelativePath = importerFileId.slice("file:".length);
  const importerDirectory = path.posix.dirname(toPosixPath(importerRelativePath));
  const importBasePath = path.posix.normalize(path.posix.join(importerDirectory, source));

  for (const candidate of createRelativeImportCandidates(importBasePath)) {
    const targetFileId = fileIdByRelativePath.get(candidate);
    if (targetFileId) {
      return targetFileId;
    }
  }

  return null;
}

function resolveAbsoluteImport(
  source: string,
  importerFileId: string,
  fileIdByRelativePath: Map<string, string>,
  jsTsConfig: JsTsResolutionConfig,
  goConfig: GoResolutionConfig,
): string | null {
  if (isJsTsFile(importerFileId)) {
    return resolveJsTsConfiguredImport(source, fileIdByRelativePath, jsTsConfig);
  }

  if (isGoFile(importerFileId)) {
    return resolveGoImport(source, fileIdByRelativePath, goConfig);
  }

  if (isRustFile(importerFileId)) {
    return resolveRustImport(source, importerFileId, fileIdByRelativePath);
  }

  if (!shouldResolveAbsoluteImport(importerFileId)) {
    return null;
  }

  const importBasePath = source.replaceAll(".", "/");
  for (const candidate of createPythonModuleCandidates(importBasePath)) {
    const targetFileId = fileIdByRelativePath.get(candidate);
    if (targetFileId) {
      return targetFileId;
    }
  }

  return null;
}

function resolveGoImport(
  source: string,
  fileIdByRelativePath: Map<string, string>,
  goConfig: GoResolutionConfig,
): string | null {
  if (!goConfig.moduleName || !source.startsWith(`${goConfig.moduleName}/`)) {
    return null;
  }

  const pkgPath = source.slice(goConfig.moduleName.length + 1);

  for (const [relativePath, fileId] of fileIdByRelativePath) {
    if (relativePath.startsWith(`${pkgPath}/`) && relativePath.endsWith(".go")) {
      return fileId;
    }
  }

  return null;
}

function shouldResolveAbsoluteImport(importerFileId: string): boolean {
  const extension = path.posix.extname(importerFileId.slice("file:".length));
  return extension === ".py" || absoluteModuleLanguages.has(extension);
}

function isJsTsFile(fileId: string): boolean {
  const extension = path.posix.extname(fileId.slice("file:".length));
  return [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(extension);
}

function isGoFile(fileId: string): boolean {
  return path.posix.extname(fileId.slice("file:".length)) === ".go";
}

function isRustFile(fileId: string): boolean {
  return path.posix.extname(fileId.slice("file:".length)) === ".rs";
}

function resolveRustImport(
  source: string,
  importerFileId: string,
  fileIdByRelativePath: Map<string, string>,
): string | null {
  const importerRelativePath = importerFileId.slice("file:".length);
  const importerDir = path.posix.dirname(toPosixPath(importerRelativePath));

  if (source.startsWith("crate::")) {
    return resolveRustCrateImport(source.slice("crate::".length), fileIdByRelativePath);
  }

  if (source.startsWith("super::")) {
    return resolveRustSuperImport(source, importerDir, fileIdByRelativePath);
  }

  // mod item: plain name, resolve relative to importer's directory
  return resolveRustModuleByName(source, importerDir, fileIdByRelativePath);
}

function resolveRustCrateImport(
  colonPath: string,
  fileIdByRelativePath: Map<string, string>,
): string | null {
  const segments = colonPath.split("::");

  for (let len = segments.length; len >= 1; len--) {
    const modulePath = segments.slice(0, len).join("/");
    for (const prefix of ["", "src/"]) {
      for (const candidate of rustModuleCandidates(`${prefix}${modulePath}`)) {
        const fileId = fileIdByRelativePath.get(candidate);
        if (fileId) return fileId;
      }
    }
  }

  return null;
}

function resolveRustSuperImport(
  source: string,
  importerDir: string,
  fileIdByRelativePath: Map<string, string>,
): string | null {
  const segments = source.split("::");
  let superCount = 0;
  while (segments[superCount] === "super") superCount++;

  let baseDir = importerDir;
  for (let i = 0; i < superCount; i++) {
    baseDir = path.posix.dirname(baseDir);
  }

  const remainingSegments = segments.slice(superCount);
  if (remainingSegments.length === 0) return null;

  for (let len = remainingSegments.length; len >= 1; len--) {
    const modulePath = remainingSegments.slice(0, len).join("/");
    const basePath = baseDir === "." ? modulePath : `${baseDir}/${modulePath}`;
    for (const candidate of rustModuleCandidates(basePath)) {
      const fileId = fileIdByRelativePath.get(candidate);
      if (fileId) return fileId;
    }
  }

  return null;
}

function resolveRustModuleByName(
  name: string,
  importerDir: string,
  fileIdByRelativePath: Map<string, string>,
): string | null {
  const basePath = importerDir === "." ? name : `${importerDir}/${name}`;
  for (const candidate of rustModuleCandidates(basePath)) {
    const fileId = fileIdByRelativePath.get(candidate);
    if (fileId) return fileId;
  }
  return null;
}

function rustModuleCandidates(basePath: string): string[] {
  return [`${basePath}.rs`, `${basePath}/mod.rs`];
}

function resolveJsTsConfiguredImport(
  source: string,
  fileIdByRelativePath: Map<string, string>,
  config: JsTsResolutionConfig,
): string | null {
  for (const candidateBasePath of createJsTsConfiguredImportBasePaths(source, config)) {
    for (const candidate of createRelativeImportCandidates(candidateBasePath)) {
      const targetFileId = fileIdByRelativePath.get(candidate);
      if (targetFileId) {
        return targetFileId;
      }
    }
  }

  return null;
}

function createJsTsConfiguredImportBasePaths(
  source: string,
  config: JsTsResolutionConfig,
): string[] {
  const candidates: string[] = [];

  for (const pathMapping of config.paths) {
    const matched = matchPathMapping(source, pathMapping);
    if (!matched) {
      continue;
    }

    for (const targetPattern of pathMapping.targets) {
      candidates.push(applyPathTarget(targetPattern, matched));
    }
  }

  if (config.baseUrl) {
    candidates.push(path.posix.join(config.baseUrl, source));
  }

  candidates.push(...createJsTsPackageImportBasePaths(source, config.packageJson));

  return candidates.map((candidate) => path.posix.normalize(candidate));
}

function createJsTsPackageImportBasePaths(
  source: string,
  packageJson: JsTsPackageJsonResolutionConfig | null,
): string[] {
  if (!packageJson?.name) {
    return [];
  }

  if (source === packageJson.name) {
    return [
      ...extractPackageExportTargets(packageJson.exports, "."),
      ...compact([packageJson.types, packageJson.main, "./index"]),
    ].map(normalizePackageTarget);
  }

  const packagePrefix = `${packageJson.name}/`;
  if (!source.startsWith(packagePrefix)) {
    return [];
  }

  const subpath = `./${source.slice(packagePrefix.length)}`;
  return [
    ...extractPackageExportTargets(packageJson.exports, subpath),
    subpath,
  ].map(normalizePackageTarget);
}

function extractPackageExportTargets(exportsValue: unknown, subpath: string): string[] {
  if (!exportsValue) {
    return [];
  }

  if (typeof exportsValue === "string" || Array.isArray(exportsValue)) {
    return subpath === "." ? extractConditionalPackageTargets(exportsValue) : [];
  }

  if (!isRecord(exportsValue)) {
    return [];
  }

  const keys = Object.keys(exportsValue);
  const hasSubpathKeys = keys.some((key) => key === "." || key.startsWith("./"));
  if (!hasSubpathKeys) {
    return subpath === "." ? extractConditionalPackageTargets(exportsValue) : [];
  }

  const exact = exportsValue[subpath];
  if (exact) {
    return extractConditionalPackageTargets(exact);
  }

  const wildcardTargets: string[] = [];
  for (const [pattern, target] of Object.entries(exportsValue)) {
    const matched = matchPackageExportPattern(subpath, pattern);
    if (matched === null) {
      continue;
    }

    for (const targetPattern of extractConditionalPackageTargets(target)) {
      wildcardTargets.push(targetPattern.replaceAll("*", matched));
    }
  }

  return wildcardTargets;
}

function extractConditionalPackageTargets(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(extractConditionalPackageTargets);
  }

  if (!isRecord(value)) {
    return [];
  }

  const preferredConditions = ["types", "import", "module", "default", "require", "node"];
  const targets: string[] = [];
  for (const condition of preferredConditions) {
    if (condition in value) {
      targets.push(...extractConditionalPackageTargets(value[condition]));
    }
  }

  if (targets.length > 0) {
    return targets;
  }

  return Object.values(value).flatMap(extractConditionalPackageTargets);
}

function matchPackageExportPattern(subpath: string, pattern: string): string | null {
  if (!pattern.includes("*")) {
    return null;
  }

  const [prefix, suffix] = pattern.split("*", 2);
  if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) {
    return null;
  }

  return subpath.slice(prefix.length, subpath.length - suffix.length);
}

function normalizePackageTarget(target: string): string {
  const normalized = toPosixPath(target);
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function compact(values: Array<string | null>): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function matchPathMapping(source: string, mapping: JsTsPathMapping): string | null {
  if (!mapping.pattern.includes("*")) {
    return source === mapping.pattern ? "" : null;
  }

  const [prefix, suffix] = mapping.pattern.split("*", 2);
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) {
    return null;
  }

  return source.slice(prefix.length, source.length - suffix.length);
}

function applyPathTarget(targetPattern: string, matchedWildcard: string): string {
  return targetPattern.includes("*")
    ? targetPattern.replace("*", matchedWildcard)
    : targetPattern;
}

function createRelativeImportCandidates(importBasePath: string): string[] {
  const candidates = new Set<string>();
  const extension = path.posix.extname(importBasePath);

  candidates.add(importBasePath);

  if (extension) {
    const withoutExtension = importBasePath.slice(0, -extension.length);
    if (jsRuntimeExtensions.includes(extension)) {
      for (const candidateExtension of importTargetExtensions) {
        candidates.add(`${withoutExtension}${candidateExtension}`);
      }
    }
  } else {
    for (const candidateExtension of importTargetExtensions) {
      candidates.add(`${importBasePath}${candidateExtension}`);
    }
  }

  for (const candidateExtension of importTargetExtensions) {
    candidates.add(path.posix.join(importBasePath, `index${candidateExtension}`));
  }
  candidates.add(path.posix.join(importBasePath, "__init__.py"));

  return [...candidates];
}

function createPythonModuleCandidates(importBasePath: string): string[] {
  return [
    `${importBasePath}.py`,
    path.posix.join(importBasePath, "__init__.py"),
  ];
}

async function readJsTsResolutionConfig(rootPath: string): Promise<JsTsResolutionConfig> {
  const emptyConfig: JsTsResolutionConfig = {
    baseUrl: null,
    paths: [],
    packageJson: null,
  };

  let rawConfig: string;
  try {
    rawConfig = await readFile(path.join(rootPath, "tsconfig.json"), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ...emptyConfig,
        packageJson: await readJsTsPackageJsonResolutionConfig(rootPath),
      };
    }

    throw error;
  }

  const parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(rawConfig)) as {
    compilerOptions?: {
      baseUrl?: unknown;
      paths?: unknown;
    };
  };
  const compilerOptions = parsed.compilerOptions ?? {};
  const baseUrl = typeof compilerOptions.baseUrl === "string"
    ? toPosixPath(compilerOptions.baseUrl)
    : null;
  const paths = parseTsconfigPaths(compilerOptions.paths, baseUrl);

  return {
    baseUrl,
    paths,
    packageJson: await readJsTsPackageJsonResolutionConfig(rootPath),
  };
}

function parseTsconfigPaths(paths: unknown, baseUrl: string | null): JsTsPathMapping[] {
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
    return [];
  }

  return Object.entries(paths)
    .filter((entry): entry is [string, string[]] => (
      typeof entry[0] === "string"
      && Array.isArray(entry[1])
      && entry[1].every((target) => typeof target === "string")
    ))
    .map(([pattern, targets]) => ({
      pattern,
      targets: targets.map((target) => {
        const normalizedTarget = toPosixPath(target);
        return baseUrl ? path.posix.join(baseUrl, normalizedTarget) : normalizedTarget;
      }),
    }));
}

function stripJsonCommentsAndTrailingCommas(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,\s*([}\]])/g, "$1");
}

async function readJsTsPackageJsonResolutionConfig(
  rootPath: string,
): Promise<JsTsPackageJsonResolutionConfig | null> {
  let rawPackageJson: string;
  try {
    rawPackageJson = await readFile(path.join(rootPath, "package.json"), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const parsed = JSON.parse(rawPackageJson) as {
    name?: unknown;
    main?: unknown;
    types?: unknown;
    typings?: unknown;
    exports?: unknown;
  };

  const types = typeof parsed.types === "string"
    ? parsed.types
    : typeof parsed.typings === "string"
      ? parsed.typings
      : null;

  return {
    name: typeof parsed.name === "string" ? parsed.name : null,
    main: typeof parsed.main === "string" ? parsed.main : null,
    types,
    exports: parsed.exports,
  };
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

async function readGoResolutionConfig(rootPath: string): Promise<GoResolutionConfig> {
  let raw: string;
  try {
    raw = await readFile(path.join(rootPath, "go.mod"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { moduleName: null };
    }
    throw error;
  }

  const match = raw.match(/^module\s+(\S+)/m);
  return { moduleName: match?.[1] ?? null };
}
