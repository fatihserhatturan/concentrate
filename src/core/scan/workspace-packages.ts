import path from "node:path";
import type { DeclaredPackage, IProjectManifestReader } from "../contracts/project-manifest.js";
import type { IGraphContributor } from "../contracts/graph-contributor.js";
import type { GraphNode } from "../graph/model.js";
import { addScanWarning, type ScanReport } from "./report.js";

// The package graph of the scan: a Package node for every package the readers
// declare, the files each contains and the dependencies between them. What a
// manifest looks like is the readers' business.
export async function addWorkspacePackageGraph(
  graph: IGraphContributor,
  repoNodeId: string,
  rootPath: string,
  report: ScanReport,
  readers: readonly IProjectManifestReader[] = [],
): Promise<void> {
  const packages = await collectDeclaredPackages(graph, rootPath, report, readers);
  if (packages.length === 0) {
    return;
  }

  for (const declared of packages) {
    const packageNode = createPackageNode(rootPath, declared);
    graph.addNode(packageNode);
    graph.addRelationship({
      from: repoNodeId,
      to: packageNode.id,
      type: "HAS_PACKAGE",
      properties: {},
    });

    addPackageConfigNodes(graph, packageNode, declared);
  }

  addPackageFileRelationships(graph, packages);
  addPackageDependencyRelationships(graph, packages);
}

// Every reader's packages; a directory already declared by an earlier reader is not declared again.
async function collectDeclaredPackages(
  graph: IGraphContributor,
  rootPath: string,
  report: ScanReport,
  readers: readonly IProjectManifestReader[],
): Promise<DeclaredPackage[]> {
  const filePaths: string[] = [];
  for (const node of graph.nodesWithLabel("File")) {
    if (typeof node.properties.relativePath === "string") filePaths.push(toPosix(node.properties.relativePath));
  }
  const packages: DeclaredPackage[] = [];
  for (const reader of readers) {
    if (!reader.readPackages) continue;
    const declared = await reader.readPackages({
      rootPath,
      filePaths,
      warn: (filePath, error) => addScanWarning(report, rootPath, filePath, error),
    });
    const taken = new Set(packages.map((existing) => existing.dir));
    for (const candidate of declared) {
      if (!taken.has(candidate.dir)) packages.push(candidate);
    }
  }
  return packages.sort((a, b) => a.dir.localeCompare(b.dir));
}

export function addImportPackageRelationships(graph: IGraphContributor): void {
  const packageIdByFileId = packageFileIndex(graph);
  const packageIdByImportId = new Map<string, string>();

  for (const type of ["IMPORTS", "RE_EXPORTS"] as const) {
    for (const relationship of graph.relationshipsOfType(type)) {
      const sourcePackageId = packageIdByFileId.get(relationship.from);
      if (sourcePackageId) {
        packageIdByImportId.set(relationship.to, sourcePackageId);
      }
    }
  }

  // Copy: the loop adds relationships of other types only, but stay a snapshot.
  for (const relationship of [...graph.relationshipsOfType("RESOLVES_TO")]) {
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

function createPackageNode(rootPath: string, workspacePackage: DeclaredPackage): GraphNode {
  const absolutePath = path.resolve(rootPath, workspacePackage.dir);
  return {
    id: packageNodeId(workspacePackage.dir),
    label: "Package",
    properties: {
      path: absolutePath,
      relativePath: workspacePackage.dir,
      name: workspacePackage.name ?? path.basename(absolutePath),
      version: workspacePackage.version,
      isPrivate: workspacePackage.isPrivate,
      manager: workspacePackage.manager,
      workspaceRoot: workspacePackage.dir === ".",
    },
  };
}

function addPackageConfigNodes(
  graph: IGraphContributor,
  packageNode: GraphNode,
  workspacePackage: DeclaredPackage,
): void {
  const values = [
    ["name", workspacePackage.name],
    ["version", workspacePackage.version],
    ["private", workspacePackage.isPrivate],
    ["packageManager", workspacePackage.manager],
  ] as const;

  for (const [key, value] of values) {
    if (value === null) {
      continue;
    }

    const nodeId = `config:package:${workspacePackage.dir}:${workspacePackage.metadataFile}:${key}`;
    graph.addNode({
      id: nodeId,
      label: "ConfigValue",
      properties: {
        name: `${workspacePackage.metadataFile}:${key}`,
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

function addPackageFileRelationships(graph: IGraphContributor, packages: DeclaredPackage[]): void {
  const packagesBySpecificity = [...packages].sort(
    (a, b) => pathDepth(b.dir) - pathDepth(a.dir),
  );

  for (const node of [...graph.nodesWithLabel("File")]) {
    const relativePath = node.properties.relativePath;
    if (typeof relativePath !== "string") {
      continue;
    }

    const owner = packagesBySpecificity.find((workspacePackage) => isWithinPackage(relativePath, workspacePackage));
    if (!owner) {
      continue;
    }

    graph.addRelationship({
      from: packageNodeId(owner.dir),
      to: node.id,
      type: "PACKAGE_CONTAINS_FILE",
      properties: {},
    });
  }
}

function addPackageDependencyRelationships(graph: IGraphContributor, packages: DeclaredPackage[]): void {
  const packageIdByName = new Map<string, string>();
  for (const workspacePackage of packages) {
    if (workspacePackage.name) {
      packageIdByName.set(workspacePackage.name, packageNodeId(workspacePackage.dir));
    }
  }

  for (const workspacePackage of packages) {
    const sourcePackageId = packageNodeId(workspacePackage.dir);
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

function packageFileIndex(graph: IGraphContributor): Map<string, string> {
  const packageIdByFileId = new Map<string, string>();
  for (const relationship of graph.relationshipsOfType("PACKAGE_CONTAINS_FILE")) {
    packageIdByFileId.set(relationship.to, relationship.from);
  }
  return packageIdByFileId;
}

function isWithinPackage(fileRelativePath: string, workspacePackage: DeclaredPackage): boolean {
  if (workspacePackage.dir === ".") {
    return true;
  }
  return fileRelativePath === workspacePackage.dir
    || fileRelativePath.startsWith(`${workspacePackage.dir}/`);
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
