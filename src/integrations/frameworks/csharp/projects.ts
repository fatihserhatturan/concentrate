import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { readCSharpProjectModel } from "../../languages/csharp/project/index.js";
import { declaredCSharpProjects } from "../../languages/csharp/manifest.js";

// What the project files tell about a project beyond what a manifest carries: the project's Package node (made by core
// from `csharpManifestReader`) gets `projectFile`, `sdk`, `outputType`, `executable`, `rootNamespace`, `assemblyName`,
// `targetFrameworks`, `usings`, `solutions` (JSON arrays), `implicitUsings`, `isTestProject` and `unresolved`. An
// executable project is an `EntryPoint` (kind `csharp-project`, declared by the `.csproj` file) that `RUNS` what the
// runtime starts in it: the `<top-level>` function of its top-level statements, else its static `Main` method(s) (the
// entrypoints of `csharp.entrypoints`, which already applies CS7022). Without either, `resolved` is false.
export const csharpProjectsContributor: ISemanticContributor = {
  id: "csharp.projects",
  dependsOn: ["csharp.entrypoints"],
  async contribute(graph, rootPath) {
    const fileIds = new Map<string, string>();
    for (const node of graph.nodesWithLabel("File")) {
      if (typeof node.properties.relativePath === "string") fileIds.set(node.properties.relativePath.replace(/\\/gu, "/"), node.id);
    }
    const model = await readCSharpProjectModel(rootPath, fileIds.keys());
    const projects = declaredCSharpProjects(model);
    if (projects.length === 0) return;

    // File node id -> the handlers of its entrypoints.
    const handlersOfFile = new Map<string, { handler: string; line: number }[]>();
    const handlerOfEntry = new Map<string, string>();
    for (const rel of graph.relationshipsOfType("ENTRYPOINT_HANDLED_BY")) handlerOfEntry.set(rel.from, rel.to);
    for (const rel of graph.relationshipsOfType("DECLARES_ENTRYPOINT")) {
      const entry = graph.node(rel.to);
      const handler = handlerOfEntry.get(rel.to);
      if (!entry || entry.properties.library !== "csharp" || entry.properties.kind !== "main" || !handler) continue;
      const list = handlersOfFile.get(rel.from) ?? [];
      list.push({ handler, line: Number(entry.properties.line) });
      handlersOfFile.set(rel.from, list);
    }
    const projectFilesOf = (dir: string, claimed: ReadonlySet<string>): string[] =>
      [...fileIds.keys()].filter((file) => (dir === "." || file.startsWith(`${dir}/`)) && !claimed.has(file)).sort();
    // A file belongs to the project with the longest directory; files of nested projects are not this project's.
    const ownedBy = (file: string): string | undefined => {
      let best: (typeof projects)[number] | undefined;
      for (const project of projects) {
        if (project.dir !== "." && !file.startsWith(`${project.dir}/`)) continue;
        if (!best || project.dir.length > best.dir.length) best = project;
      }
      return best?.file;
    };

    for (const project of projects) {
      const packageNode = graph.node(`package:${project.dir}`);
      // Another manifest owns the directory.
      if (!packageNode || packageNode.properties.manager !== "dotnet") continue;
      Object.assign(packageNode.properties, {
        projectFile: project.file,
        sdk: project.sdk,
        outputType: project.outputType,
        executable: project.executable,
        rootNamespace: project.rootNamespace,
        assemblyName: project.assemblyName,
        targetFrameworks: JSON.stringify(project.targetFrameworks),
        implicitUsings: project.implicitUsings,
        usings: JSON.stringify(project.usings),
        isTestProject: project.isTestProject,
        solutions: JSON.stringify(project.solutions),
        unresolved: project.unresolved,
      });
      if (!project.executable) continue;
      const projectFileId = fileIds.get(project.file);
      if (!projectFileId) continue;

      const entries: { handler: string; line: number }[] = [];
      for (const file of projectFilesOf(project.dir, new Set())) {
        if (ownedBy(file) !== project.file) continue;
        const id = fileIds.get(file);
        if (id) entries.push(...(handlersOfFile.get(id) ?? []));
      }
      const entryId = `entrypoint:csharp:${project.file}`;
      graph.addNode({
        id: entryId,
        label: "EntryPoint",
        properties: {
          kind: "csharp-project",
          trigger: project.assemblyName,
          receiverName: null,
          library: "dotnet",
          line: project.line,
          handlerName: null,
          source: project.outputType,
          resolved: entries.length > 0,
        },
      });
      graph.addRelationship({ from: projectFileId, to: entryId, type: "DECLARES_ENTRYPOINT", properties: {} });
      for (const { handler, line } of entries) {
        graph.addRelationship({ from: entryId, to: handler, type: "RUNS", properties: { line, command: "dotnet run" } });
      }
    }
  },
};
