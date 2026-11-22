import path from "node:path/posix";
import { readXml, type XmlElement } from "../../syntax/xml.js";
import type { CSharpSolution } from "./types.js";

export type SolutionInput = {
  /** Every scanned file (scan-relative posix paths): used to tell whether a listed project exists. */
  files: Set<string>;
  /** Text of each `.sln` and `.slnx` file, by path. */
  texts: Map<string, string>;
};

export type SolutionResult = {
  solutions: CSharpSolution[];
  unresolved: number;
};

const SOLUTION_FOLDER_TYPE = "2150E333-8FDC-42A3-9474-1A3956D46DE8";
const SLN_PROJECT = /^\s*Project\(\s*"\{([^}"]*)\}"\s*\)\s*=\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"\{[^}"]*\}"/u;

// Resolve a project path written in a solution against the solution's directory; null when it leaves the scan root.
function resolveProjectPath(solutionFile: string, written: string): string | null {
  const posix = written.trim().replace(/\\/g, "/");
  if (posix === "") return null;
  const dir = path.dirname(solutionFile);
  const joined = path.normalize(dir === "." ? posix : `${dir}/${posix}`);
  if (joined === ".." || joined.startsWith("../") || joined.startsWith("/")) return null;
  return joined.replace(/^\.\//, "");
}

function isCsproj(file: string): boolean {
  return file.trim().toLowerCase().endsWith(".csproj");
}

function slnProjectPaths(text: string): string[] {
  const paths: string[] = [];
  let inGlobal = false;
  for (const line of text.replace(/^﻿/, "").split(/\r\n|\r|\n/)) {
    if (/^\s*Global\s*$/u.test(line)) inGlobal = true;
    if (inGlobal) continue;
    const match = SLN_PROJECT.exec(line);
    if (!match) continue;
    if (match[1]!.toUpperCase() === SOLUTION_FOLDER_TYPE) continue;
    if (!isCsproj(match[3]!)) continue;
    paths.push(match[3]!);
  }
  return paths;
}

function slnxProjectPaths(text: string): string[] {
  const paths: string[] = [];
  const visit = (element: XmlElement): void => {
    if (element.name === "Project") {
      const written = element.attributes.Path;
      if (written && isCsproj(written)) paths.push(written);
    }
    for (const child of element.children) visit(child);
  };
  visit(readXml(text.replace(/^﻿/, "")).root);
  return paths;
}

export function interpretSolutions(input: SolutionInput): SolutionResult {
  const solutions: CSharpSolution[] = [];
  let unresolved = 0;
  let lower: Map<string, string> | undefined;
  const lowerFiles = (): Map<string, string> => {
    if (!lower) {
      lower = new Map();
      for (const file of [...input.files].sort()) if (!lower.has(file.toLowerCase())) lower.set(file.toLowerCase(), file);
    }
    return lower;
  };
  for (const file of [...input.texts.keys()].sort()) {
    const text = input.texts.get(file)!;
    const format = file.toLowerCase().endsWith(".slnx") ? "slnx" : "sln";
    const written = format === "slnx" ? slnxProjectPaths(text) : slnProjectPaths(text);
    const projects = new Set<string>();
    let missing = 0;
    for (const entry of written) {
      const resolved = resolveProjectPath(file, entry);
      const canonical = resolved === null ? null : input.files.has(resolved) ? resolved : (lowerFiles().get(resolved.toLowerCase()) ?? null);
      if (canonical !== null) projects.add(canonical);
      else missing += 1;
    }
    unresolved += missing;
    solutions.push({ file, format, projects: [...projects].sort(), unresolved: missing });
  }
  return { solutions, unresolved };
}
