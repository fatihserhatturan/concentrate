import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import {
  byFileAndLine,
  loadComponentFunctions,
  loadComponents,
  loadFunctions,
  loadRenderEdges,
  matchesFileOrDirectory,
  walkCalls,
} from "./graph.js";

// Styles in the MCP tools: a class (`.btn`), an id (`#hero`) or a custom
// property (`--color-brand`), and who uses it. Shared by find_references
// (each use) and impact_of (the components, pages and files a change reaches).

type Row = Record<string, unknown>;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

export type StyleTarget = { id: string; kind: "class" | "id" | "custom-property"; name: string; file: string; line: number | null; scope: string | null };

// `.btn`, `#hero` and `--color-brand` name a style; a plain name is a symbol.
export function parseStyleSymbol(symbol: string | undefined): { kind: StyleTarget["kind"]; name: string } | null {
  if (!symbol) return null;
  if (/^--[^\s]+$/u.test(symbol)) return { kind: "custom-property", name: symbol };
  if (/^\.[^\s.#]+$/u.test(symbol)) return { kind: "class", name: symbol.slice(1) };
  if (/^#[^\s.#]+$/u.test(symbol)) return { kind: "id", name: symbol.slice(1) };
  return null;
}

export function isStyleFilePath(file: string | undefined): boolean {
  return file !== undefined && /\.(?:css|scss|sass|less)$/iu.test(file);
}

// The styles a symbol names, or, for a style file alone, every class, id and
// custom property it declares; `file` narrows a symbol to the sheets it
// matches.
export async function loadStyleTargets(engine: IQueryEngine, symbol: string | undefined, file: string | undefined): Promise<StyleTarget[]> {
  const parsed = parseStyleSymbol(symbol);
  const rows = await engine.query(`
    MATCH (declaring:File)-[:DECLARES_STYLE]->(style:Style)
    WHERE style.kind <> 'rule' ${parsed ? "AND style.kind = $kind AND style.name = $name" : ""}
    RETURN id(style) AS id, style.kind AS kind, style.name AS name, declaring.relativePath AS file, style.line AS line, style.scope AS scope
  `, parsed ?? {}) as Row[];
  return rows
    .filter((row) => !file || matchesFileOrDirectory(str(row.file), file))
    .map((row) => ({
      id: String(row.id),
      kind: String(row.kind) as StyleTarget["kind"],
      name: String(row.name),
      file: String(row.file),
      line: num(row.line),
      scope: str(row.scope),
    }))
    .sort(byFileAndLine);
}

export function describeStyle(target: StyleTarget) {
  const prefix = target.kind === "class" ? "." : target.kind === "id" ? "#" : "";
  return { name: `${prefix}${target.name}`, kind: target.kind, file: target.file, line: target.line, ...(target.scope ? { scope: target.scope } : {}) };
}

const provenanceOf = (row: Row) => (typeof row.provenance === "string" && row.provenance !== "exact" ? { provenance: row.provenance } : {});

export type StyleUse = {
  as: "component" | "function" | "file";
  name: string;
  file: string | null;
  line: number | null;
  match: string | null;
  // Set when the link is not exact (a class matched on its name alone).
  provenance?: string;
  expression: string | null;
  style: string;
  // Component or Function node id of the user; null for a file.
  id: string | null;
};

// Everything that uses the styles through USES_STYLE, and the rules that
// select them.
export async function loadStyleUses(engine: IQueryEngine, ids: readonly string[]) {
  if (ids.length === 0) return { uses: [] as StyleUse[], rules: [] as Row[] };
  const params = { ids: [...ids] };
  const [files, functions, components, rules] = await Promise.all([
    engine.query(`
      MATCH (owner:File)-[rel:USES_STYLE_FILE]->(style:Style)
      WHERE id(style) IN $ids
      RETURN id(style) AS style, owner.relativePath AS file, rel.line AS line, rel.match AS match, rel.provenance AS provenance, rel.expression AS expression
    `, params),
    engine.query(`
      MATCH (owner:Function)-[rel:USES_STYLE_FUNCTION]->(style:Style)
      WHERE id(style) IN $ids
      RETURN id(style) AS style, id(owner) AS id, rel.line AS line, rel.match AS match, rel.provenance AS provenance, rel.expression AS expression
    `, params),
    engine.query(`
      MATCH (file:File)-[:DECLARES_COMPONENT]->(owner:Component)-[rel:USES_STYLE_COMPONENT]->(style:Style)
      WHERE id(style) IN $ids
      RETURN id(style) AS style, id(owner) AS id, owner.name AS name, file.relativePath AS file, rel.line AS line, rel.match AS match, rel.provenance AS provenance, rel.expression AS expression
    `, params),
    engine.query(`
      MATCH (file:File)-[:DECLARES_STYLE]->(rule:Style)-[:SELECTS_STYLE]->(style:Style)
      WHERE id(style) IN $ids
      RETURN id(style) AS style, rule.selector AS selector, rule.atRule AS atRule, file.relativePath AS file, rule.line AS line
    `, params),
  ]) as Row[][];
  const functionInfo = await loadFunctions(engine, [...new Set(functions!.map((row) => String(row.id)))]);
  const uses: StyleUse[] = [
    ...files!.map((row): StyleUse => ({ as: "file", name: String(row.file), file: str(row.file), line: num(row.line), match: str(row.match), ...provenanceOf(row), expression: str(row.expression), style: String(row.style), id: null })),
    ...functions!.map((row): StyleUse => {
      const info = functionInfo.get(String(row.id));
      return {
        as: "function",
        name: info ? (info.className ? `${info.className}.${info.name}` : info.name) : String(row.id),
        file: info?.file ?? null,
        line: num(row.line),
        match: str(row.match),
        ...provenanceOf(row),
        expression: str(row.expression),
        style: String(row.style),
        id: String(row.id),
      };
    }),
    ...components!.map((row): StyleUse => ({ as: "component", name: String(row.name), file: str(row.file), line: num(row.line), match: str(row.match), ...provenanceOf(row), expression: str(row.expression), style: String(row.style), id: String(row.id) })),
  ];
  return { uses: uses.sort(byFileAndLine), rules: rules!.sort(byFileAndLine) };
}

// impact_of for styles: the users above, then the components that render a
// using component (up to `maxDepth` levels) and the pages that render any of
// them. A class is used by components that name it; a custom property is
// used from style files, so the components of the files that import those
// (transitively) are reached too, at the depth they import.
export async function styleImpact(engine: IQueryEngine, targets: readonly StyleTarget[], maxDepth: number, limit: number) {
  const ids = targets.map((target) => target.id);
  const { uses, rules } = await loadStyleUses(engine, ids);
  const customProperty = targets.some((target) => target.kind === "custom-property");

  const componentIds = new Set(uses.filter((use) => use.as === "component").map((use) => use.id!));
  const functionIds = uses.filter((use) => use.as === "function").map((use) => use.id!);
  for (const { component } of await loadComponentFunctions(engine, functionIds)) componentIds.add(component);

  let importers: Array<{ file: string; depth: number }> = [];
  if (customProperty) {
    const userFiles = [...new Set(uses.filter((use) => use.as === "file" && use.file).map((use) => use.file!))];
    importers = await importingFiles(engine, userFiles, maxDepth);
    const components = await engine.query(`
      MATCH (file:File)-[:DECLARES_COMPONENT]->(component:Component)
      WHERE file.relativePath IN $files
      RETURN id(component) AS id
    `, { files: [...userFiles, ...importers.map((entry) => entry.file)] }) as Row[];
    for (const row of components) componentIds.add(String(row.id));
  }

  const [components, renders] = await Promise.all([loadComponents(engine), loadRenderEdges(engine)]);
  const depth = walkCalls(renders.map(({ parent, child, line }) => ({ caller: parent, callee: child, line })), componentIds, "up", maxDepth);
  const pageRows = depth.size === 0 ? [] : await engine.query(`
    MATCH (file:File)-[:DECLARES_PAGE]->(page:Page)-[:PAGE_RENDERS]->(component:Component)
    WHERE id(component) IN $ids
    RETURN page.fullPath AS fullPath, page.framework AS framework, page.router AS router, page.kind AS kind,
      file.relativePath AS file, page.line AS line, id(component) AS component
  `, { ids: [...depth.keys()] }) as Row[];
  const pages = pageRows.map((row) => ({
    fullPath: str(row.fullPath),
    framework: str(row.framework),
    kind: str(row.kind),
    file: str(row.file),
    line: num(row.line),
    renders: components.get(String(row.component))?.name ?? String(row.component),
    depth: depth.get(String(row.component))!,
  })).sort((a, b) => a.depth - b.depth || String(a.fullPath).localeCompare(String(b.fullPath)) || byFileAndLine(a, b));
  const impacted = [...depth].map(([id, level]) => {
    const component = components.get(id);
    return { name: component?.name ?? id, kind: component?.kind ?? null, file: component?.file ?? null, line: component?.line ?? null, depth: level };
  }).sort((a, b) => a.depth - b.depth || byFileAndLine(a, b));

  const plainUses = uses.map(({ id: _id, style, ...use }) => ({ ...use, style: targets.length > 1 ? styleLabel(targets.find((target) => target.id === style)) : undefined }));
  return {
    styles: targets.slice(0, limit).map(describeStyle),
    ...(targets.length > limit ? { moreStyles: targets.length - limit } : {}),
    users: plainUses.slice(0, limit),
    ...(plainUses.length > limit ? { usersTruncated: plainUses.length } : {}),
    rules: rules.slice(0, limit).map((row) => ({ selector: str(row.selector), ...(targets.length > 1 ? { style: styleLabel(targets.find((target) => target.id === row.style)) } : {}), ...(str(row.atRule) ? { atRule: str(row.atRule) } : {}), file: str(row.file), line: num(row.line) })),
    ...(rules.length > limit ? { rulesTruncated: rules.length } : {}),
    components: impacted.slice(0, limit),
    pages: pages.slice(0, limit),
    ...(customProperty ? { importers: importers.slice(0, limit) } : {}),
  };
}

function styleLabel(target: StyleTarget | undefined): string | undefined {
  return target ? describeStyle(target).name : undefined;
}

// Files that import any of `files` (an import that resolves to it),
// transitively up to `maxDepth` levels, with the depth they import at.
async function importingFiles(engine: IQueryEngine, files: readonly string[], maxDepth: number): Promise<Array<{ file: string; depth: number }>> {
  if (files.length === 0) return [];
  const rows = await engine.query(`
    MATCH (importer:File)-[:IMPORTS]->(:Import)-[:RESOLVES_TO]->(target:File)
    RETURN importer.relativePath AS importer, target.relativePath AS target
  `) as Row[];
  const importersOf = new Map<string, string[]>();
  for (const row of rows) {
    const target = String(row.target);
    const list = importersOf.get(target);
    if (list) list.push(String(row.importer));
    else importersOf.set(target, [String(row.importer)]);
  }
  const seen = new Set(files);
  const found: Array<{ file: string; depth: number }> = [];
  let frontier = [...files];
  for (let level = 1; level <= maxDepth && frontier.length > 0; level++) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const importer of importersOf.get(file) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        found.push({ file: importer, depth: level });
        next.push(importer);
      }
    }
    frontier = next;
  }
  return found.sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
}
