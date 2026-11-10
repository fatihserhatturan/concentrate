import { readFile } from "node:fs/promises";
import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { GraphNode } from "../../../core/graph/model.js";
import { envVar } from "../js-ts/env-files.js";
import type { DockerInstruction } from "../../languages/plain/dockerfile.js";
import type { ScriptScan } from "./shell.js";

// What the readers of scripts and infrastructure share: the entrypoints they
// add, the commands still to be linked (`RUNS`) once every file is read, and
// the lookup tables `RUNS` resolves against.

export type Pending = {
  from: string;
  // Directories commands run in (relative to the root, "" for the root), tried in order.
  cwds: string[];
  commands: Array<{ text: string; line: number }>;
  // The Dockerfile (and its build context) the commands run in: a path inside
  // the container (`/app/start.sh`) is looked up in what it copies.
  image?: { dockerfile: string; context: string };
};

export type Context = {
  graph: IGraphContributor;
  rootPath: string;
  repoId: string;
  fileIds: Map<string, string>;
  // `<dir>\0<script>` → entrypoint id, for `npm run` and the pre/post hooks.
  npmScripts: Map<string, string>;
  // `<dir>\0<target>` → entrypoint id.
  makeTargets: Map<string, string>;
  // script file → entrypoint id.
  scriptEntries: Map<string, string>;
  // Dockerfile → its instructions, for the container paths of `RUNS`.
  dockerfiles: Map<string, DockerInstruction[]>;
  pending: Pending[];
};

export function entrypoint(ctx: Context, fileId: string, id: string, properties: { kind: string; trigger: string; library: string; line: number; handlerName: string | null }): string {
  const node: GraphNode = { id, label: "EntryPoint", properties: { receiverName: null, ...properties } };
  ctx.graph.addNode(node);
  ctx.graph.addRelationship({ from: fileId, to: id, type: "DECLARES_ENTRYPOINT", properties: {} });
  return id;
}

export function addEnv(ctx: Context, owner: string, relative: string, scan: ScriptScan, lineOffset = 0): void {
  for (const read of scan.reads) {
    ctx.graph.addRelationship({ from: owner, to: envVar(ctx.graph, read.name), type: "USES_ENV", properties: { line: read.line + lineOffset, access: read.access } });
  }
  for (const declaration of scan.declarations) {
    ctx.graph.addRelationship({ from: ctx.repoId, to: envVar(ctx.graph, declaration.name), type: "DECLARES_ENV", properties: { file: relative, line: declaration.line + lineOffset } });
  }
}


export async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}
