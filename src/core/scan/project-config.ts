import type { IFileSystem } from "../contracts/file-system.js";
import type { IProjectManifestReader } from "../contracts/project-manifest.js";
import type { IGraphContributor } from "../contracts/graph-contributor.js";
import { addScanWarning, type ScanReport } from "./report.js";

// The values the project's manifests declare (`package.json`, `tsconfig.json`, ...),
// as ConfigValue nodes of the repository. The readers know the files; the order is theirs.
export async function addProjectConfigNodes(
  graph: IGraphContributor,
  repoNodeId: string,
  rootPath: string,
  report: ScanReport | undefined,
  fileSystem: IFileSystem,
  readers: readonly IProjectManifestReader[] = [],
): Promise<void> {
  for (const reader of readers) {
    if (!reader.readConfig) continue;
    const values = await reader.readConfig({
      rootPath,
      fileSystem,
      filePaths: [],
      warn: (filePath, error) => {
        if (report) addScanWarning(report, rootPath, filePath, error);
      },
    });
    for (const { source, key, value } of values) {
      const node = {
        id: `config:${source}:${key}`,
        label: "ConfigValue" as const,
        properties: {
          name: `${source}:${key}`,
          value: String(value),
          valueType: typeof value,
          line: 0,
        },
      };

      graph.addNode(node);
      graph.addRelationship({
        from: repoNodeId,
        to: node.id,
        type: "DECLARES_CONFIG",
        properties: {},
      });
    }
  }
}
