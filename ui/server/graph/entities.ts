import { loadIndex, nodeName, type GraphIndex, type IndexNode } from "./index.js";

export const ENTITY_KINDS = ["files", "routes", "tables", "components", "env", "entrypoints"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export type Column = {
  key: string;
  label: string;
  /** How the cell is drawn; numbers are right aligned, badges are small pills, code is monospaced. */
  kind?: "text" | "number" | "badge" | "code";
  /** The table offers a drop-down filter on this column. */
  filter?: boolean;
};
export type EntityRow = { id: string } & Record<string, string | number | boolean | null>;
export type EntityTable = {
  kind: EntityKind;
  columns: Column[];
  rows: EntityRow[];
  /** What the inspector shows when no row is selected: counts by one grouping. */
  summary: { by: string; groups: Array<{ label: string; count: number }> };
};

const cache = new WeakMap<GraphIndex, Map<EntityKind, EntityTable>>();

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

function group(rows: EntityRow[], key: string, by: string): EntityTable["summary"] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = String(row[key] ?? "unknown");
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return { by, groups: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label, count]) => ({ label, count })) };
}

/** Number of stored relationships of a type pattern that end at each node. */
function incoming(index: GraphIndex, pattern: RegExp): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of index.stored) if (pattern.test(edge.type)) counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1);
  return counts;
}

export function fileOfNode(index: GraphIndex, id: string): { path: string; line: number | null } | null {
  const owner = index.fileOf.get(id);
  const file = owner ? index.nodes.get(owner) : undefined;
  if (!file) return null;
  const line = index.nodes.get(id)?.props.line;
  return { path: String(file.props.relativePath ?? ""), line: typeof line === "number" ? line : null };
}

function byLabel(index: GraphIndex, ...labels: string[]): IndexNode[] {
  const wanted = new Set(labels);
  return [...index.nodes.values()].filter((n) => wanted.has(n.label));
}

/** How many other files each file uses and is used by (imports, calls, requests, ...), each file counted once. */
export function fileDegrees(index: GraphIndex): { out: Map<string, number>; inn: Map<string, number> } {
  const out = new Map<string, number>();
  const inn = new Map<string, number>();
  const seen = new Set<string>();
  for (const edge of index.edges) {
    if (edge.kind === "defines") continue;
    const a = index.fileOf.get(edge.from);
    const b = index.fileOf.get(edge.to);
    if (!a || !b || a === b || seen.has(`${a}\0${b}`)) continue;
    seen.add(`${a}\0${b}`);
    out.set(a, (out.get(a) ?? 0) + 1);
    inn.set(b, (inn.get(b) ?? 0) + 1);
  }
  return { out, inn };
}

function build(index: GraphIndex, kind: EntityKind): EntityTable {
  switch (kind) {
    case "files": {
      const { out, inn } = fileDegrees(index);
      const rows = byLabel(index, "File").map((n): EntityRow => {
        const p = n.props;
        const type = p.isTest === true ? "test" : p.isGenerated === true ? "generated" : p.isDocs === true ? "docs" : p.isFixture === true ? "fixture" : "source";
        return {
          id: n.id, path: String(p.relativePath ?? n.id), language: str(p.language) ?? "other", type,
          package: index.packageOf.get(n.id) ?? null, usesOthers: out.get(n.id) ?? 0, usedByOthers: inn.get(n.id) ?? 0,
          links: (out.get(n.id) ?? 0) + (inn.get(n.id) ?? 0),
        };
      });
      return {
        kind, rows,
        columns: [
          { key: "path", label: "File", kind: "code" }, { key: "language", label: "Language", kind: "badge", filter: true },
          { key: "type", label: "Type", kind: "badge", filter: true }, { key: "package", label: "Package", filter: true },
          { key: "usesOthers", label: "Uses", kind: "number" }, { key: "usedByOthers", label: "Used by", kind: "number" },
        ],
        summary: group(rows, "language", "Language"),
      };
    }
    case "routes": {
      const rows = byLabel(index, "Route").map((n): EntityRow => {
        const p = n.props;
        const handler = (index.out.get(n.id) ?? []).find((e) => e.type === "ROUTE_HANDLED_BY");
        const at = fileOfNode(index, n.id);
        return {
          id: n.id, method: String(p.method ?? "ANY").toUpperCase(), path: str(p.fullPath) ?? str(p.path) ?? "", framework: str(p.framework) ?? "unknown",
          handler: handler ? nodeName(index.nodes.get(handler.to)!) : str(p.handlerName), file: at?.path ?? null, line: at?.line ?? null,
        };
      });
      return {
        kind, rows,
        columns: [
          { key: "method", label: "Method", kind: "badge", filter: true }, { key: "path", label: "Path", kind: "code" },
          { key: "handler", label: "Handler" }, { key: "framework", label: "Framework", filter: true }, { key: "file", label: "File", kind: "code" },
        ],
        summary: group(rows, "framework", "Framework"),
      };
    }
    case "tables": {
      const reads = incoming(index, /^READS_/);
      const writes = incoming(index, /^WRITES_/);
      const rows = byLabel(index, "Table", "DataModel").map((n): EntityRow => {
        const p = n.props;
        const isTable = n.label === "Table";
        return {
          id: n.id, name: str(p.name) ?? n.id, type: isTable ? "table" : "model", library: str(p.library) ?? "unknown",
          schema: str(p.schemaName), declaredIn: str(p.declaredIn) ?? fileOfNode(index, n.id)?.path ?? null,
          reads: isTable ? reads.get(n.id) ?? 0 : null, writes: isTable ? writes.get(n.id) ?? 0 : null,
        };
      });
      return {
        kind, rows,
        columns: [
          { key: "name", label: "Name", kind: "code" }, { key: "type", label: "Type", kind: "badge", filter: true },
          { key: "library", label: "Library", filter: true }, { key: "declaredIn", label: "Declared in", kind: "code" },
          { key: "reads", label: "Reads", kind: "number" }, { key: "writes", label: "Writes", kind: "number" },
        ],
        summary: group(rows, "library", "Library"),
      };
    }
    case "components": {
      const renderedBy = incoming(index, /^(RENDERS|PAGE_RENDERS)$/);
      const rows = byLabel(index, "Component", "Page").map((n): EntityRow => {
        const p = n.props;
        const at = fileOfNode(index, n.id);
        const page = n.label === "Page";
        return {
          id: n.id, name: page ? str(p.fullPath) ?? str(p.path) ?? n.id : str(p.name) ?? n.id, type: page ? "page" : "component",
          framework: str(p.framework) ?? "unknown", kind: str(p.kind), usedBy: renderedBy.get(n.id) ?? 0, file: at?.path ?? null, line: at?.line ?? null,
        };
      });
      return {
        kind, rows,
        columns: [
          { key: "name", label: "Name", kind: "code" }, { key: "type", label: "Type", kind: "badge", filter: true },
          { key: "framework", label: "Framework", filter: true }, { key: "kind", label: "Kind", filter: true },
          { key: "usedBy", label: "Rendered by", kind: "number" }, { key: "file", label: "File", kind: "code" },
        ],
        summary: group(rows, "framework", "Framework"),
      };
    }
    case "env": {
      const usedBy = incoming(index, /^USES_ENV_/);
      const declared = incoming(index, /^DECLARES_ENV$/);
      const rows = byLabel(index, "EnvVar").map((n): EntityRow => ({
        id: n.id, name: str(n.props.name) ?? n.id, exposure: n.props.isPublic === true ? "public" : "private",
        usedBy: usedBy.get(n.id) ?? 0, declared: (declared.get(n.id) ?? 0) > 0 ? "yes" : "no",
      }));
      return {
        kind, rows,
        columns: [
          { key: "name", label: "Variable", kind: "code" }, { key: "exposure", label: "Exposure", kind: "badge", filter: true },
          { key: "declared", label: "Declared in an env file", kind: "badge", filter: true }, { key: "usedBy", label: "Used by", kind: "number" },
        ],
        summary: group(rows, "exposure", "Exposure"),
      };
    }
    case "entrypoints": {
      const rows = byLabel(index, "EntryPoint").map((n): EntityRow => {
        const p = n.props;
        const handler = (index.out.get(n.id) ?? []).find((e) => e.type === "ENTRYPOINT_HANDLED_BY");
        const at = fileOfNode(index, n.id);
        return {
          id: n.id, kind: str(p.kind) ?? "unknown", trigger: str(p.trigger), library: str(p.library),
          handler: handler ? nodeName(index.nodes.get(handler.to)!) : str(p.handlerName), file: at?.path ?? null, line: at?.line ?? null,
        };
      });
      return {
        kind, rows,
        columns: [
          { key: "kind", label: "Kind", kind: "badge", filter: true }, { key: "trigger", label: "Trigger", kind: "code" },
          { key: "handler", label: "Handler" }, { key: "library", label: "Library", filter: true }, { key: "file", label: "File", kind: "code" },
        ],
        summary: group(rows, "kind", "Kind"),
      };
    }
  }
}

export function entityTable(index: GraphIndex, kind: EntityKind): EntityTable {
  let tables = cache.get(index);
  if (!tables) cache.set(index, (tables = new Map()));
  let table = tables.get(kind);
  if (!table) tables.set(kind, (table = build(index, kind)));
  return table;
}

export async function entities(projectPath: string, kind: string): Promise<EntityTable> {
  if (!(ENTITY_KINDS as readonly string[]).includes(kind)) throw new Error(`kind must be one of ${ENTITY_KINDS.join(", ")}`);
  return entityTable(await loadIndex(projectPath), kind as EntityKind);
}

/** How many rows each view has; a view with none is left out of the navigation. */
export async function catalog(projectPath: string): Promise<{ views: Record<EntityKind, number> }> {
  const index = await loadIndex(projectPath);
  return { views: Object.fromEntries(ENTITY_KINDS.map((kind) => [kind, entityTable(index, kind).rows.length])) as Record<EntityKind, number> };
}
