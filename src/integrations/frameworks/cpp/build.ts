import path from "node:path";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode } from "../../../core/graph/model.js";
import { readBuildModel, type BuildTarget } from "../../languages/cpp/build/index.js";

// The targets of a C or C++ project's CMake files and Makefiles in the graph:
// every executable and library is a `Package` node (manager `cmake` or `make`,
// `targetType`, the build file that creates it) that contains the source files
// it compiles (`PACKAGE_CONTAINS_FILE`) and imports the targets it links
// (`PACKAGE_IMPORTS_PACKAGE`, dependencyType `link`). An executable is an
// `EntryPoint` (kind `cmake-executable`; a Makefile target keeps its `make`
// entrypoint) that `RUNS` the `main` entrypoints of its sources.

export const cppBuildContributor: ISemanticContributor = {
  async contribute(graph, rootPath) {
    const repo = graph.nodes.find((node) => node.label === "Repo");
    if (!repo) return;
    const fileIds = new Map<string, string>();
    let hasBuildFiles = false;
    for (const node of graph.nodes) {
      if (node.label !== "File" || typeof node.properties.relativePath !== "string") continue;
      fileIds.set(node.properties.relativePath.split(path.sep).join("/"), node.id);
      if (node.properties.language === "cmake" || node.properties.language === "makefile") hasBuildFiles = true;
    }
    if (!hasBuildFiles) return;

    const model = await readBuildModel(rootPath, fileIds.keys());
    if (model.targets.length === 0) return;

    const mainsByFile = new Map<string, string[]>();
    const existing = new Set<string>();
    for (const node of graph.nodes) {
      if (node.label === "EntryPoint") existing.add(node.id);
    }
    const mains = new Set<string>();
    for (const node of graph.nodes) {
      if (node.label === "EntryPoint" && node.properties.kind === "main" && (node.properties.library === "c" || node.properties.library === "cpp")) mains.add(node.id);
    }
    for (const rel of graph.relationships) {
      if (rel.type !== "DECLARES_ENTRYPOINT" || !mains.has(rel.to)) continue;
      mainsByFile.set(rel.from, [...mainsByFile.get(rel.from) ?? [], rel.to]);
    }

    const packageId = (target: BuildTarget) => `package:${target.system}:${target.dir}:${target.name}`;
    const byKey = new Map(model.targets.map((target) => [`${target.system}:${target.name}`, target]));
    for (const target of model.targets) {
      const id = packageId(target);
      const node: GraphNode = {
        id,
        label: "Package",
        properties: {
          path: path.join(rootPath, target.dir),
          relativePath: target.dir === "" ? "." : target.dir,
          name: target.name,
          version: null,
          isPrivate: false,
          manager: target.system,
          workspaceRoot: false,
          targetType: target.type,
          buildFile: target.file,
          unresolved: target.unresolved,
        },
      };
      graph.addNode(node);
      graph.addRelationship({ from: repo.id, to: id, type: "HAS_PACKAGE", properties: {} });
      for (const source of target.sources) {
        const fileId = fileIds.get(source);
        if (fileId) graph.addRelationship({ from: id, to: fileId, type: "PACKAGE_CONTAINS_FILE", properties: {} });
      }
      const linked = new Set<string>();
      for (const link of target.links) {
        const other = byKey.get(link.target);
        if (!other || linked.has(link.target)) continue;
        linked.add(link.target);
        graph.addRelationship({ from: id, to: packageId(other), type: "PACKAGE_IMPORTS_PACKAGE", properties: { dependencyType: "link" } });
      }

      if (target.type !== "executable") continue;
      const buildFileId = fileIds.get(target.file);
      if (!buildFileId) continue;
      const entryId = target.system === "make" ? `entrypoint:make:${target.file}:${target.name}` : `entrypoint:cmake:${target.file}:${target.name}`;
      if (!existing.has(entryId)) {
        graph.addNode({
          id: entryId,
          label: "EntryPoint",
          properties: { kind: target.system === "make" ? "make" : "cmake-executable", trigger: target.name, receiverName: null, library: target.system, line: target.line, handlerName: null },
        });
        graph.addRelationship({ from: buildFileId, to: entryId, type: "DECLARES_ENTRYPOINT", properties: {} });
        existing.add(entryId);
      }
      const runs = new Set<string>();
      for (const source of target.sources) {
        const fileId = fileIds.get(source);
        for (const main of fileId ? mainsByFile.get(fileId) ?? [] : []) {
          if (runs.has(main)) continue;
          runs.add(main);
          graph.addRelationship({ from: entryId, to: main, type: "RUNS", properties: { line: target.line, command: `${target.system} target ${target.name}` } });
        }
      }
    }
  },
};
