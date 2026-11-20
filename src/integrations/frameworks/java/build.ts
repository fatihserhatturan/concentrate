import path from "node:path";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { isJavaBuildFile, readJavaBuildModel } from "../../languages/java/build/index.js";
import { declaredJavaModules } from "../../languages/java/project.js";

// What the Java build files tell about a module beyond what a manifest carries: the module's Package
// node (made by core from `javaManifestReader`) gets `buildSystem`, `sourceRoots`, `testSourceRoots`
// (JSON arrays), `aggregator`, `mainClass`, `mainClassSource`, `buildFile` and `unresolved`. A module's
// `mainClass` is an `EntryPoint` (kind `java-main-class`, declared by the build file) that `RUNS` the
// `main` entrypoint of that class; when the class or its `main` is not in the scan the EntryPoint stays
// without `RUNS` and `resolved` is false.
export const javaBuildContributor: ISemanticContributor = {
  id: "java.build",
  dependsOn: ["java.entrypoints"],
  async contribute(graph, rootPath) {
    const fileIds = new Map<string, string>();
    let hasBuildFiles = false;
    for (const node of graph.nodesWithLabel("File")) {
      if (typeof node.properties.relativePath !== "string") continue;
      const relative = node.properties.relativePath.split(path.sep).join("/");
      fileIds.set(relative, node.id);
      if (isJavaBuildFile(relative)) hasBuildFiles = true;
    }
    if (!hasBuildFiles) return;

    const files = [...fileIds.keys()];
    const model = await readJavaBuildModel(rootPath, files);
    const modules = declaredJavaModules(model, files);
    if (modules.length === 0) return;

    const entryByFunction = new Map<string, string>();
    for (const rel of graph.relationshipsOfType("ENTRYPOINT_HANDLED_BY")) entryByFunction.set(rel.to, rel.from);
    const classByName = new Map<string, string>();
    for (const node of graph.nodesWithLabel("Class")) {
      if (typeof node.properties.qualifiedName === "string") classByName.set(node.properties.qualifiedName, node.id);
    }
    // Class id -> its `main` EntryPoint.
    const mainOfClass = new Map<string, string>();
    for (const rel of graph.relationshipsOfType("DEFINES_METHOD")) {
      const entry = entryByFunction.get(rel.to);
      if (entry && !mainOfClass.has(rel.from)) mainOfClass.set(rel.from, entry);
    }

    for (const module of modules) {
      const packageNode = graph.node(`package:${module.dir}`);
      // Another manifest (a `package.json`) owns the directory.
      if (!packageNode || packageNode.properties.manager !== module.system) continue;
      Object.assign(packageNode.properties, {
        buildSystem: module.system,
        sourceRoots: JSON.stringify(module.sourceRoots),
        testSourceRoots: JSON.stringify(module.testSourceRoots),
        aggregator: module.aggregator,
        mainClass: module.mainClass,
        mainClassSource: module.mainClassSource,
        buildFile: module.file,
        unresolved: module.unresolved,
      });

      if (!module.mainClass) continue;
      const buildFileId = fileIds.get(module.file);
      if (!buildFileId) continue;
      const classId = classByName.get(module.mainClass) ?? classByName.get(module.mainClass.replace(/\$/gu, "."));
      const mainId = classId ? mainOfClass.get(classId) : undefined;
      const entryId = `entrypoint:java:${module.file}:${module.name}`;
      graph.addNode({
        id: entryId,
        label: "EntryPoint",
        properties: {
          kind: "java-main-class",
          trigger: module.mainClass,
          receiverName: null,
          library: "java",
          line: module.line,
          handlerName: "main",
          source: module.mainClassSource,
          resolved: mainId !== undefined,
        },
      });
      graph.addRelationship({ from: buildFileId, to: entryId, type: "DECLARES_ENTRYPOINT", properties: {} });
      if (mainId) graph.addRelationship({ from: entryId, to: mainId, type: "RUNS", properties: { line: module.line, command: `${module.mainClassSource ?? "mainClass"} ${module.mainClass}` } });
    }
  },
};
