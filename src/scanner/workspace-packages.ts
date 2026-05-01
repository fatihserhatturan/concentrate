import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { GraphBuilder } from "../graph/builder.js";
import type { GraphNode } from "../graph/model.js";
import { addScanWarning, type ScanReport } from "./report.js";

type PackageMetadata = {
  name: string | null;
  version: string | null;
  private: boolean;
  packageManager: string | null;
  dependencies: PackageDependency[];
};

type PackageDependency = {
  name: string;
  type: "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";
};

type WorkspacePackage = PackageMetadata & {
  absolutePath: string;
  relativePath: string;
  workspaceRoot: boolean;
};

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const commonWorkspacePatterns = [
  "apps/*",
  "packages/*",
  "libs/*",
  "services/*",
];

export async function addWorkspacePackageGraph(
  graph: GraphBuilder,
  repoNodeId: string,
  rootPath: string,
  report: ScanReport,
): Promise<void> {
  const packages = await detectWorkspacePackages(rootPath, report);
  if (packages.length === 0) {
    return;
  }

  for (const workspacePackage of packages) {
    const packageNode = createPackageNode(workspacePackage);
    graph.addNode(packageNode);
    graph.addRelationship({
      from: repoNodeId,
      to: packageNode.id,
      type: "HAS_PACKAGE",
      properties: {},
    });

    addPackageConfigNodes(graph, packageNode, workspacePackage);
  }

  addPackageFileRelationships(graph, packages);
  addPackageDependencyRelationships(graph, packages);
}

export function addImportPackageRelationships(graph: GraphBuilder): void {
  const packageIdByFileId = packageFileIndex(graph);
  const packageIdByImportId = new Map<string, string>();

  for (const relationship of graph.relationships) {
    if (relationship.type !== "IMPORTS" && relationship.type !== "RE_EXPORTS") {
      continue;
    }

    const sourcePackageId = packageIdByFileId.get(relationship.from);
    if (sourcePackageId) {
      packageIdByImportId.set(relationship.to, sourcePackageId);
    }
  }

  for (const relationship of graph.relationships) {
    if (relationship.type !== "RESOLVES_TO") {
      continue;
    }

    const targetPackageId = packageIdByFileId.get(relationship.to);
    if (!targetPackageId) {
      continue;
    }

    graph.addRelationship({
      from: relationship.from,
      to: targetPackageId,
      type: "IMPORTS_PACKAGE",
      properties: {},
    });

    const sourcePackageId = packageIdByImportId.get(relationship.from);
    if (sourcePackageId && sourcePackageId !== targetPackageId) {
      graph.addRelationship({
        from: sourcePackageId,
        to: targetPackageId,
        type: "PACKAGE_IMPORTS_PACKAGE",
        properties: {
          dependencyType: "internalImport",
        },
      });
    }
  }
}

async function detectWorkspacePackages(rootPath: string, report: ScanReport): Promise<WorkspacePackage[]> {
  const rootPackage = await readPackageMetadata(path.join(rootPath, "package.json"), rootPath, report);
  const workspacePatterns = [
    ...extractPackageJsonWorkspacePatterns(rootPackage?.raw),
    ...await readPnpmWorkspacePatterns(rootPath, report),
  ];

  const effectivePatterns = workspacePatterns.length > 0 ? workspacePatterns : commonWorkspacePatterns;
  const packageJsonPaths = new Set<string>();

  if (rootPackage) {
    packageJsonPaths.add("package.json");
  }

  for (const pattern of effectivePatterns) {
    for (const packageJsonPath of await findPackageJsons(rootPath, pattern)) {
      packageJsonPaths.add(packageJsonPath);
    }
  }

  const packages: WorkspacePackage[] = [];
  for (const packageJsonPath of [...packageJsonPaths].sort()) {
    const absolutePackageJsonPath = path.join(rootPath, packageJsonPath);
    const metadata = await readPackageMetadata(absolutePackageJsonPath, rootPath, report);
    if (!metadata) {
      continue;
    }

    const relativePath = toPosix(path.dirname(packageJsonPath));
    packages.push({
      absolutePath: path.dirname(absolutePackageJsonPath),
      relativePath,
      workspaceRoot: relativePath === ".",
      ...metadata,
    });
  }

  return packages.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function readPackageMetadata(
  packageJsonPath: string,
  rootPath: string,
  report: ScanReport,
): Promise<(PackageMetadata & { raw: Record<string, unknown> }) | null> {
  let raw: string;
  try {
    raw = await readFile(packageJsonPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      addScanWarning(report, rootPath, packageJsonPath, error);
    }
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    addScanWarning(report, rootPath, packageJsonPath, error);
    return null;
  }

  return {
    raw: parsed,
    name: typeof parsed.name === "string" ? parsed.name : null,
    version: typeof parsed.version === "string" ? parsed.version : null,
    private: parsed.private === true,
    packageManager: typeof parsed.packageManager === "string" ? parsed.packageManager : null,
    dependencies: readPackageDependencies(parsed),
  };
}

function extractPackageJsonWorkspacePatterns(parsed: Record<string, unknown> | undefined): string[] {
  if (!parsed) {
    return [];
  }

  const workspaces = parsed.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((value): value is string => typeof value === "string");
  }

  if (workspaces && typeof workspaces === "object" && !Array.isArray(workspaces)) {
    const packages = (workspaces as Record<string, unknown>).packages;
    if (Array.isArray(packages)) {
      return packages.filter((value): value is string => typeof value === "string");
    }
  }

  return [];
}

async function readPnpmWorkspacePatterns(rootPath: string, report: ScanReport): Promise<string[]> {
  const pnpmWorkspacePath = path.join(rootPath, "pnpm-workspace.yaml");
  let raw: string;
  try {
    raw = await readFile(pnpmWorkspacePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      addScanWarning(report, rootPath, pnpmWorkspacePath, error);
    }
    return [];
  }

  const patterns: string[] = [];
  let inPackages = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "packages:") {
      inPackages = true;
      continue;
    }

    if (!inPackages) {
      continue;
    }

    if (trimmed.length > 0 && !trimmed.startsWith("-")) {
      break;
    }

    const match = trimmed.match(/^-\s*['"]?([^'"]+)['"]?$/);
    if (match?.[1] && !match[1].startsWith("!")) {
      patterns.push(match[1]);
    }
  }

  return patterns;
}

async function findPackageJsons(rootPath: string, pattern: string): Promise<string[]> {
  const packageJsonPattern = pattern.endsWith("package.json")
    ? pattern
    : path.posix.join(pattern, "package.json");

  return fg(packageJsonPattern, {
    cwd: rootPath,
    dot: true,
    onlyFiles: true,
    absolute: false,
    ignore: ["**/node_modules/**"],
  });
}

function readPackageDependencies(parsed: Record<string, unknown>): PackageDependency[] {
  const dependencies: PackageDependency[] = [];

  for (const field of dependencyFields) {
    const value = parsed[field];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    for (const dependencyName of Object.keys(value)) {
      dependencies.push({ name: dependencyName, type: field });
    }
  }

  return dependencies;
}

function createPackageNode(workspacePackage: WorkspacePackage): GraphNode {
  return {
    id: packageNodeId(workspacePackage.relativePath),
    label: "Package",
    properties: {
      path: workspacePackage.absolutePath,
      relativePath: workspacePackage.relativePath,
      name: workspacePackage.name ?? path.basename(workspacePackage.absolutePath),
      version: workspacePackage.version,
      isPrivate: workspacePackage.private,
      manager: workspacePackage.packageManager,
      workspaceRoot: workspacePackage.workspaceRoot,
    },
  };
}

function addPackageConfigNodes(
  graph: GraphBuilder,
  packageNode: GraphNode,
  workspacePackage: WorkspacePackage,
): void {
  const values = [
    ["name", workspacePackage.name],
    ["version", workspacePackage.version],
    ["private", workspacePackage.private],
    ["packageManager", workspacePackage.packageManager],
  ] as const;

  for (const [key, value] of values) {
    if (value === null) {
      continue;
    }

    const nodeId = `config:package:${workspacePackage.relativePath}:package.json:${key}`;
    graph.addNode({
      id: nodeId,
      label: "ConfigValue",
      properties: {
        name: `package.json:${key}`,
        value: String(value),
        valueType: typeof value,
        line: 0,
      },
    });
    graph.addRelationship({
      from: packageNode.id,
      to: nodeId,
      type: "PACKAGE_DECLARES_CONFIG",
      properties: {},
    });
  }
}

function addPackageFileRelationships(graph: GraphBuilder, packages: WorkspacePackage[]): void {
  const packagesBySpecificity = [...packages].sort(
    (a, b) => pathDepth(b.relativePath) - pathDepth(a.relativePath),
  );

  for (const node of graph.nodes) {
    if (node.label !== "File") {
      continue;
    }

    const relativePath = node.properties.relativePath;
    if (typeof relativePath !== "string") {
      continue;
    }

    const owner = packagesBySpecificity.find((workspacePackage) => isWithinPackage(relativePath, workspacePackage));
    if (!owner) {
      continue;
    }

    graph.addRelationship({
      from: packageNodeId(owner.relativePath),
      to: node.id,
      type: "PACKAGE_CONTAINS_FILE",
      properties: {},
    });
  }
}

function addPackageDependencyRelationships(graph: GraphBuilder, packages: WorkspacePackage[]): void {
  const packageIdByName = new Map<string, string>();
  for (const workspacePackage of packages) {
    if (workspacePackage.name) {
      packageIdByName.set(workspacePackage.name, packageNodeId(workspacePackage.relativePath));
    }
  }

  for (const workspacePackage of packages) {
    const sourcePackageId = packageNodeId(workspacePackage.relativePath);
    for (const dependency of workspacePackage.dependencies) {
      const targetPackageId = packageIdByName.get(dependency.name);
      if (!targetPackageId) {
        continue;
      }

      graph.addRelationship({
        from: sourcePackageId,
        to: targetPackageId,
        type: "PACKAGE_IMPORTS_PACKAGE",
        properties: {
          dependencyType: dependency.type,
        },
      });
    }
  }
}

function packageFileIndex(graph: GraphBuilder): Map<string, string> {
  const packageIdByFileId = new Map<string, string>();
  for (const relationship of graph.relationships) {
    if (relationship.type === "PACKAGE_CONTAINS_FILE") {
      packageIdByFileId.set(relationship.to, relationship.from);
    }
  }
  return packageIdByFileId;
}

function isWithinPackage(fileRelativePath: string, workspacePackage: WorkspacePackage): boolean {
  if (workspacePackage.relativePath === ".") {
    return true;
  }
  return fileRelativePath === workspacePackage.relativePath
    || fileRelativePath.startsWith(`${workspacePackage.relativePath}/`);
}

function packageNodeId(relativePath: string): string {
  return `package:${relativePath}`;
}

function pathDepth(relativePath: string): number {
  return relativePath === "." ? 0 : relativePath.split("/").length;
}

function toPosix(value: string): string {
  if (!value || value === ".") {
    return ".";
  }
  return value.split(path.sep).join(path.posix.sep);
}
