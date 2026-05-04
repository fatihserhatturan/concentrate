import path from "node:path";
import { GraphBuilder } from "../graph/builder.js";

export function addDirectoryChain(
  graph: GraphBuilder,
  repoNodeId: string,
  rootPath: string,
  directoryPath: string,
): string {
  const rootDirectoryNodeId = addDirectoryNode(graph, rootPath, ".");
  graph.addRelationship({
    from: repoNodeId,
    to: rootDirectoryNodeId,
    type: "CONTAINS_ROOT",
    properties: {},
  });

  const relativeDirectoryPath = path.relative(rootPath, directoryPath);
  if (!relativeDirectoryPath) {
    return rootDirectoryNodeId;
  }

  let parentNodeId = rootDirectoryNodeId;
  for (const segment of relativeDirectoryPath.split(path.sep)) {
    const currentRelativePath = parentNodeId === "dir:."
      ? segment
      : path.posix.join(parentNodeId.slice("dir:".length), segment);
    const currentNodeId = addDirectoryNode(graph, rootPath, currentRelativePath);

    graph.addRelationship({
      from: parentNodeId,
      to: currentNodeId,
      type: "CONTAINS_DIRECTORY",
      properties: {},
    });

    parentNodeId = currentNodeId;
  }

  return parentNodeId;
}

function addDirectoryNode(graph: GraphBuilder, rootPath: string, relativePath: string): string {
  const id = `dir:${relativePath}`;
  const absolutePath = relativePath === "." ? rootPath : path.join(rootPath, relativePath);

  graph.addNode({
    id,
    label: "Directory",
    properties: {
      path: absolutePath,
      relativePath,
      name: relativePath === "." ? path.basename(rootPath) : path.basename(relativePath),
    },
  });

  return id;
}
