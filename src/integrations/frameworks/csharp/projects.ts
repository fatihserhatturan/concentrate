import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { projectOfFile, readCSharpProjectModel } from "../../languages/csharp/project/index.js";
import { ownerProjects } from "../../languages/csharp/owner-projects.js";

// What the project files tell about a project beyond what a manifest carries: the project's Package node (made by core
// from `csharpManifestReader`) gets `projectFile`, `sdk`, `outputType`, `executable`, `rootNamespace`, `assemblyName`,
// `targetFrameworks`, `usings`, `solutions`, `packageReferences` (`[{name, version}]`) (JSON arrays), `implicitUsings`, `isTestProject` and `unresolved`. An
// executable project is an `EntryPoint` (kind `csharp-project`, declared by the `.csproj` file) that `RUNS` what the
// runtime starts in it: the `main` entrypoint of its top-level statements, else of its static `Main` method(s) (the
// entrypoints of `csharp.entrypoints`, which already applies CS7022). Without either, `resolved` is false.
export const csharpProjectsContributor: ISemanticContributor = {
  id: "csharp.projects",
  dependsOn: ["csharp.entrypoints"],
  async contribute(graph, rootPath) {
    const fileIds = new Map<string, string>();
    for (const node of graph.nodesWithLabel("File")) {
      if (typeof node.properties.relativePath === "string") fileIds.set(node.properties.relativePath.replace(/\\/gu, "/"), node.id);
    }
    const fullModel = await readCSharpProjectModel(rootPath, fileIds.keys());
    const projects = ownerProjects(fullModel);
    const model = { ...fullModel, projects };
    if (projects.length === 0) return;

    // File node id -> the `main` entrypoints it declares (the store only allows RUNS from an EntryPoint to a File or
    // another EntryPoint, so the project runs the entrypoint whose handler is `<top-level>` or `Main`).
    const handlersOfFile = new Map<string, { handler: string; line: number }[]>();
    for (const rel of graph.relationshipsOfType("DECLARES_ENTRYPOINT")) {
      const entry = graph.node(rel.to);
      if (!entry || entry.properties.library !== "csharp" || entry.properties.kind !== "main") continue;
      const list = handlersOfFile.get(rel.from) ?? [];
      list.push({ handler: rel.to, line: Number(entry.properties.line) });
      handlersOfFile.set(rel.from, list);
    }
    // Entrypoints per project (by project file); a file belongs to the project `projectOfFile` names (longest directory).
    const entriesOf = new Map<string, { handler: string; line: number }[]>();
    for (const [file, id] of [...fileIds].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) {
      const handlers = handlersOfFile.get(id);
      if (!handlers) continue;
      const owner = projectOfFile(model, file);
      if (!owner) continue;
      const list = entriesOf.get(owner.file) ?? [];
      list.push(...handlers);
      entriesOf.set(owner.file, list);
    }

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
        packageReferences: JSON.stringify(project.packageReferences),
        unresolved: project.unresolved,
      });
      if (!project.executable) continue;
      const projectFileId = fileIds.get(project.file);
      if (!projectFileId) continue;

      const entries = entriesOf.get(project.file) ?? [];
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
