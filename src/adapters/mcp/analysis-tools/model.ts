import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { parseNamespaceReExport, parseReExportNames } from "../../../core/graph/re-exports.js";

// Graph reads shared by the analysis tools: every declaration, every file and
// the file-to-file import graph, plus an index that follows an imported name
// through re-exports to the declarations it ends at.

type Row = Record<string, unknown>;

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

export type DeclarationKind = "function" | "method" | "class" | "interface" | "type" | "enum" | "variable";

export type Declaration = {
  id: string;
  kind: DeclarationKind;
  name: string;
  className: string | null;
  file: string;
  line: number | null;
  // Exported by its own declaration (`export function f`) or by a local
  // `export { f }` in its file.
  isExported: boolean;
};

export type FileInfo = {
  file: string;
  language: string | null;
  sourceType: string | null;
  isTest: boolean;
  isFixture: boolean;
  isGenerated: boolean;
  // Go: the package clause.
  packageName?: string | null;
};

export type ImportBinding = { imported: string; local: string; kind: string };

export type ImportEdge = {
  id: string;
  file: string;
  target: string | null;
  source: string;
  line: number | null;
  isReExport: boolean;
  isWildcard: boolean;
  isDynamic: boolean;
  isCjs: boolean;
  isTypeOnly: boolean;
  bindings: ImportBinding[];
  // Names of `export { a as b } from` re-exports ({ imported: a, exported: b });
  // the graph keeps only the statement text for these.
  reExports: Array<{ imported: string; exported: string }>;
  // `export * as ns from`: the namespace's name.
  namespaceExport: string | null;
};

const declarationQueries: Array<{ kind: DeclarationKind; cypher: string }> = [
  {
    kind: "function",
    cypher: `
      MATCH (file:File)-[:DEFINES_FUNCTION]->(n:Function)
      RETURN id(n) AS id, n.name AS name, n.className AS className, file.relativePath AS file, n.line AS line,
        n.isExported AS isExported
    `,
  },
  {
    kind: "method",
    cypher: `
      MATCH (file:File)-[:DEFINES_CLASS]->(class:Class)-[:DEFINES_METHOD]->(n:Function)
      RETURN id(n) AS id, n.name AS name, class.name AS className, file.relativePath AS file, n.line AS line,
        false AS isExported
    `,
  },
  ...([
    ["class", "Class", "DEFINES_CLASS"],
    ["interface", "Interface", "DEFINES_INTERFACE"],
    ["type", "TypeAlias", "DEFINES_TYPE_ALIAS"],
    ["enum", "Enum", "DEFINES_ENUM"],
    ["variable", "Variable", "DEFINES_VARIABLE"],
  ] as const).map(([kind, label, relationship]) => ({
    kind,
    cypher: `
      MATCH (file:File)-[:${relationship}]->(n:${label})
      RETURN id(n) AS id, n.name AS name, NULL AS className, file.relativePath AS file, n.line AS line,
        n.isExported AS isExported
    `,
  })),
];

// Every declaration, in file and line order. Inline functions the scanner
// names after their position ("<router.get:/users:arg1>") are left out.
export async function loadDeclarations(engine: IQueryEngine): Promise<Declaration[]> {
  const [localExports, ...results] = await Promise.all([
    engine.query(`
      MATCH (file:File)-[:RE_EXPORTS_FUNCTION|RE_EXPORTS_CLASS|RE_EXPORTS_VARIABLE]->(n)
      RETURN id(n) AS id
    `),
    ...declarationQueries.map(({ cypher }) => engine.query(cypher)),
  ]) as Row[][];
  const reExported = new Set(localExports!.map((row) => str(row.id)));

  const seen = new Set<string>();
  const declarations: Declaration[] = [];
  results.forEach((rows, index) => {
    const kind = declarationQueries[index]!.kind;
    for (const row of rows) {
      const id = str(row.id);
      const name = str(row.name);
      if (!id || !name || name.startsWith("<") || seen.has(id)) continue;
      seen.add(id);
      const className = str(row.className);
      declarations.push({
        id,
        // A function node that belongs to a class is a method even when it is
        // reached through DEFINES_FUNCTION.
        kind: kind === "function" && className ? "method" : kind,
        name,
        className,
        file: str(row.file) ?? "",
        line: num(row.line),
        isExported: row.isExported === true || reExported.has(id),
      });
    }
  });
  return declarations.sort(byFileAndLine);
}

export async function loadFiles(engine: IQueryEngine): Promise<Map<string, FileInfo>> {
  const rows = await engine.query(`
    MATCH (file:File)
    RETURN file.relativePath AS file, file.language AS language, file.sourceType AS sourceType, file.isTest AS isTest, file.isFixture AS isFixture,
      file.isGenerated AS isGenerated, file.packageName AS packageName
  `) as Row[];
  return new Map(rows.flatMap((row) => {
    const file = str(row.file);
    return file
      ? [[file, { file, language: str(row.language), sourceType: str(row.sourceType), isTest: row.isTest === true, isFixture: row.isFixture === true, isGenerated: row.isGenerated === true, packageName: str(row.packageName) }]]
      : [];
  }));
}

// Every import and re-export statement with the file it resolves to (null
// for packages and unresolved paths), in file and line order.
export async function loadImports(engine: IQueryEngine): Promise<ImportEdge[]> {
  const rows = await engine.query(`
    MATCH (file:File)-[:IMPORTS]->(imp:Import)
    OPTIONAL MATCH (imp)-[:RESOLVES_TO]->(target:File)
    RETURN id(imp) AS id, file.relativePath AS file, target.relativePath AS target, imp.source AS source,
      imp.specifier AS specifier, imp.line AS line, imp.isReExport AS isReExport, imp.isWildcard AS isWildcard,
      imp.isDynamic AS isDynamic, imp.isCjs AS isCjs, imp.isTypeOnly AS isTypeOnly, imp.bindings AS bindings
  `) as Row[];
  const edges = new Map<string, ImportEdge>();
  for (const row of rows) {
    const id = str(row.id);
    const file = str(row.file);
    if (!id || !file || edges.has(id)) continue;
    const specifier = str(row.specifier) ?? "";
    const isReExport = row.isReExport === true;
    edges.set(id, {
      id,
      file,
      target: str(row.target),
      source: str(row.source) ?? "",
      line: num(row.line),
      isReExport,
      isWildcard: row.isWildcard === true,
      isDynamic: row.isDynamic === true,
      isCjs: row.isCjs === true,
      isTypeOnly: row.isTypeOnly === true || /^\s*(?:import|export)\s+type\b/.test(specifier),
      bindings: parseBindings(row.bindings),
      reExports: isReExport ? parseReExportNames(specifier) : [],
      namespaceExport: isReExport ? parseNamespaceReExport(specifier) : null,
    });
  }
  return [...edges.values()].sort(byFileAndLine);
}

function parseBindings(value: unknown): ImportBinding[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.flatMap((item) => {
        const binding = item as Partial<ImportBinding>;
        return typeof binding.imported === "string"
          ? [{ imported: binding.imported, local: typeof binding.local === "string" ? binding.local : binding.imported, kind: String(binding.kind ?? "named") }]
          : [];
      })
      : [];
  } catch {
    return [];
  }
}

// How an imported name reaches declarations: through the target file's own
// exports, `export { a as b } from` and `export * from` chains.
export class ExportIndex {
  private readonly exportsByFile = new Map<string, Declaration[]>();
  private readonly reExportsByFile = new Map<string, ImportEdge[]>();
  private readonly cache = new Map<string, Resolution>();

  constructor(declarations: readonly Declaration[], imports: readonly ImportEdge[]) {
    for (const declaration of declarations) {
      if (!declaration.isExported || declaration.kind === "method") continue;
      push(this.exportsByFile, declaration.file, declaration);
    }
    for (const edge of imports) {
      if (edge.isReExport && edge.target) push(this.reExportsByFile, edge.file, edge);
    }
  }

  // The declarations `name` exported by `file` ends at, the re-export
  // statements on the way, and whether the name is a namespace re-export
  // (`export * as ns`) of a whole file.
  resolve(file: string, name: string): Resolution {
    const key = `${file}\0${name}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const result: Resolution = { declarations: [], via: [], namespaces: [] };
    this.cache.set(key, result); // guards export * cycles
    for (const declaration of this.exportsByFile.get(file) ?? []) {
      if (declaration.name === name) result.declarations.push(declaration);
    }
    for (const edge of this.reExportsByFile.get(file) ?? []) {
      const target = edge.target!;
      if (edge.namespaceExport === name) {
        result.namespaces.push(target);
        result.via.push(edge);
        continue;
      }
      const renamed = edge.reExports.find((entry) => entry.exported === name);
      const forwarded = renamed ? renamed.imported : edge.isWildcard && !edge.namespaceExport && name !== "default" ? name : null;
      if (forwarded === null) continue;
      const inner = this.resolve(target, forwarded);
      if (inner.declarations.length === 0 && inner.namespaces.length === 0) continue;
      result.declarations.push(...inner.declarations);
      result.namespaces.push(...inner.namespaces);
      result.via.push(edge, ...inner.via);
    }
    return result;
  }

  // Files whose whole export surface `file`'s surface includes (`export *`).
  wildcardTargets(file: string): string[] {
    return (this.reExportsByFile.get(file) ?? []).filter((edge) => edge.isWildcard).map((edge) => edge.target!);
  }

  // Named re-exports of `file`, as names it exports.
  reExportedNames(file: string): string[] {
    return (this.reExportsByFile.get(file) ?? []).flatMap((edge) => edge.reExports.map((entry) => entry.exported));
  }
}

export type Resolution = { declarations: Declaration[]; via: ImportEdge[]; namespaces: string[] };

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function byFileAndLine(left: { file?: string | null; line?: number | null }, right: { file?: string | null; line?: number | null }): number {
  const a = left.file ?? "";
  const b = right.file ?? "";
  return (a < b ? -1 : a > b ? 1 : 0) || (left.line ?? 0) - (right.line ?? 0);
}

// Short description of a declaration for tool output.
export function describeDeclaration(declaration: Declaration) {
  return {
    kind: declaration.kind,
    name: declaration.name,
    ...(declaration.className ? { className: declaration.className } : {}),
    file: declaration.file,
    line: declaration.line,
  };
}
