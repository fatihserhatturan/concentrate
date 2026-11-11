import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode } from "../../../core/graph/model.js";
import { readPythonProjects } from "../../languages/python/project.js";
import { createPythonResolver } from "../../languages/python/resolution.js";

// Console scripts a project installs (`[project.scripts]`, Poetry scripts,
// `setup.cfg` / `setup.py` `console_scripts`): `name = "pkg.mod:func"` is an
// EntryPoint (kind `script`, trigger the command name) declared by the
// metadata file and handled by the function it names (`Class.method` too).
// A function the module only re-exports (`from .x import main`) is not followed.
export const pythonEntrypointsContributor: ISemanticContributor = {
  async contribute(graph, rootPath) {
    const files = new Map<string, string>();
    for (const node of graph.nodes) {
      if (node.label === "File" && typeof node.properties.relativePath === "string") files.set(node.properties.relativePath.split("\\").join("/"), node.id);
    }
    const projects = (await readPythonProjects(rootPath, files.keys())).filter((project) => project.scripts.length > 0);
    if (projects.length === 0) return;
    const resolver = createPythonResolver(projects, new Set(files.keys()));

    const functionsByFile = new Map<string, GraphNode[]>();
    const fileByFunction = new Map<string, string>();
    for (const rel of graph.relationships) if (rel.type === "DEFINES_FUNCTION" || rel.type === "DEFINES_METHOD") fileByFunction.set(rel.to, rel.from);
    const fileOfClass = new Map<string, string>();
    for (const rel of graph.relationships) if (rel.type === "DEFINES_CLASS") fileOfClass.set(rel.to, rel.from);
    for (const node of graph.nodes) {
      if (node.label !== "Function") continue;
      let file = fileByFunction.get(node.id);
      if (file && fileOfClass.has(file)) file = fileOfClass.get(file);
      if (!file) continue;
      functionsByFile.set(file, [...functionsByFile.get(file) ?? [], node]);
    }

    for (const project of projects) {
      const declaredIn = project.files[0] ? files.get(project.files[0]) : undefined;
      if (!declaredIn) continue;
      for (const script of project.scripts) {
        const match = /^([\w.]+)\s*:\s*([\w.]+)/u.exec(script.target);
        if (!match) continue;
        const [, module, member] = match as unknown as [string, string, string];
        const [target] = resolver.resolveImport({ importerFile: project.files[0]!, source: module, importedName: null }).files;
        const [className, methodName] = member.includes(".") ? member.split(".") as [string, string] : [null, member];
        const handler = target
          ? functionsByFile.get(files.get(target) ?? "")?.find((fn) => fn.properties.name === (methodName ?? member) && (fn.properties.className ?? null) === className)
          : undefined;
        const entrypoint: GraphNode = {
          id: `${declaredIn}:entrypoint:0:0:script:${script.name}`,
          label: "EntryPoint",
          properties: { kind: "script", trigger: script.name, receiverName: null, library: "python", line: 0, handlerName: methodName ?? member },
        };
        graph.addNode(entrypoint);
        graph.addRelationship({ from: declaredIn, to: entrypoint.id, type: "DECLARES_ENTRYPOINT", properties: {} });
        if (handler) graph.addRelationship({ from: entrypoint.id, to: handler.id, type: "ENTRYPOINT_HANDLED_BY", properties: {} });
      }
    }
  },
};
