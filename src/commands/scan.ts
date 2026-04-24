import path from "node:path";
import { discoverFiles } from "../scanner/discover-files.js";
import { detectLanguage } from "../scanner/language.js";
import { parseSourceFile } from "../parsers/index.js";
import { KuzuGraphWriter } from "../graph/kuzu-writer.js";
import type { GraphNode, GraphRelationship } from "../graph/model.js";

type ScanOptions = {
  database: string;
};

export async function scanCommand(projectPath: string, options: ScanOptions): Promise<void> {
  const rootPath = path.resolve(projectPath);
  const databasePath = path.resolve(options.database);
  const files = await discoverFiles(rootPath);
  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];

  nodes.push({
    id: `repo:${rootPath}`,
    label: "Repo",
    properties: {
      path: rootPath,
      name: path.basename(rootPath),
    },
  });

  for (const filePath of files) {
    const language = detectLanguage(filePath);
    if (!language) {
      continue;
    }

    const parsed = await parseSourceFile(rootPath, filePath, language);
    nodes.push(...parsed.nodes);
    relationships.push(...parsed.relationships);

    relationships.push({
      from: `repo:${rootPath}`,
      to: parsed.fileNodeId,
      type: "CONTAINS",
      properties: {},
    });
  }

  const writer = await KuzuGraphWriter.open(databasePath);
  await writer.reset();
  await writer.write(nodes, relationships);
  await writer.close();

  console.log(`Scanned ${files.length} files`);
  console.log(`Wrote ${nodes.length} nodes and ${relationships.length} relationships`);
  console.log(`Database: ${databasePath}`);
}
