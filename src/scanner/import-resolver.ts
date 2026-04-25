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
};

type JsTsPathMapping = {
  pattern: string;
  targets: string[];
};

export async function addImportResolutionRelationships(graph: GraphBuilder, rootPath: string): Promise<{
  resolved: number;
  unresolved: number;
}> {
  const fileIdByRelativePath = createFileIndex(graph.nodes);
  const importerFileIdByImportId = createImporterIndex(graph.relationships);
  const jsTsConfig = await readJsTsResolutionConfig(rootPath);
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
    if (!importerFileId || !shouldAttemptResolution(source, importerFileId, jsTsConfig)) {
      continue;
    }

    const targetFileId = resolveImport(source, importerFileId, fileIdByRelativePath, jsTsConfig);

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
): boolean {
  if (source.startsWith(".")) {
    return true;
  }

  if (isJsTsFile(importerFileId)) {
    return createJsTsConfiguredImportBasePaths(source, jsTsConfig).length > 0;
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
): string | null {
  if (!source.startsWith(".")) {
    return resolveAbsoluteImport(source, importerFileId, fileIdByRelativePath, jsTsConfig);
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
): string | null {
  if (isJsTsFile(importerFileId)) {
    return resolveJsTsConfiguredImport(source, fileIdByRelativePath, jsTsConfig);
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

function shouldResolveAbsoluteImport(importerFileId: string): boolean {
  const extension = path.posix.extname(importerFileId.slice("file:".length));
  return extension === ".py" || absoluteModuleLanguages.has(extension);
}

function isJsTsFile(fileId: string): boolean {
  const extension = path.posix.extname(fileId.slice("file:".length));
  return [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(extension);
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

  return candidates.map((candidate) => path.posix.normalize(candidate));
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
  };

  let rawConfig: string;
  try {
    rawConfig = await readFile(path.join(rootPath, "tsconfig.json"), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return emptyConfig;
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

  return { baseUrl, paths };
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

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}
