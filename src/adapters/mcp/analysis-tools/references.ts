import type { IQueryEngine } from "../../../core/contracts/query-engine.js";
import { optionalString, requiredString } from "../args.js";
import { loadFunctions, matchesFileOrDirectory } from "../agent-tools/graph.js";
import type { PageWindow } from "../paging.js";
import { byFileAndLine, type Declaration, type DeclarationKind, describeDeclaration, ExportIndex, loadDeclarations, loadImports } from "./model.js";
import { DECLARATION_KINDS } from "./search.js";
import { describeStyle, loadStyleTargets, loadStyleUses, parseStyleSymbol } from "../agent-tools/styles.js";

type Row = Record<string, unknown>;

export type Reference = {
  kind: string;
  file: string;
  line: number | null;
  // The declaration referenced, as file:line, when several matched.
  target?: string;
  // The function, class or route the reference is in.
  from?: string;
  detail?: string;
  // Set when the reference may not use this declaration (namespace and
  // dynamic imports of its file).
  possible?: true;
};

const MAX_DECLARATIONS = 20;

// find_references: where a declaration is used. Calls and callbacks come from
// resolved call edges; imports and re-exports follow the import graph by
// name through barrels; classes add subclasses, implementations and
// injection sites; functions add the routes and entrypoints they handle.
export async function findReferences(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const symbol = requiredString(args.symbol, "symbol");
  const file = optionalString(args.file);
  if (parseStyleSymbol(symbol)) return findStyleReferences(engine, symbol, file, window);
  const kind = optionalString(args.kind);
  if (kind && !DECLARATION_KINDS.includes(kind as DeclarationKind)) {
    throw new Error(`Unknown kind ${JSON.stringify(kind)}; expected one of ${DECLARATION_KINDS.join(", ")}`);
  }
  const dot = symbol.lastIndexOf(".");
  const [className, name] = dot > 0 ? [symbol.slice(0, dot), symbol.slice(dot + 1)] : [null, symbol];

  const [declarations, imports] = await Promise.all([loadDeclarations(engine), loadImports(engine)]);
  const targets = declarations.filter((declaration) =>
    declaration.name === name
    && (!className || (declaration.kind === "method" && declaration.className === className))
    && (!file || matchesFileOrDirectory(declaration.file, file))
    && (!kind || declaration.kind === kind));
  if (targets.length === 0) {
    return { symbol, declarations: [], note: "No declaration matched. Use search_symbols for a fuzzy search." };
  }

  const several = targets.length > 1;
  const label = (declaration: Declaration) => (several ? { target: `${declaration.file}:${declaration.line ?? "?"}` } : {});
  const byId = new Map(targets.map((declaration) => [declaration.id, declaration]));
  const references: Reference[] = [];
  const add = (declaration: Declaration | undefined, reference: Reference) => {
    if (declaration) references.push({ ...reference, ...label(declaration) });
  };

  // Imports and re-exports, for declarations a file can export.
  const exportable = targets.filter((declaration) => declaration.kind !== "method");
  if (exportable.length > 0) {
    const index = new ExportIndex(declarations, imports);
    const surfaces = new Map<string, Set<string>>(); // file -> files whose exports it includes through export *
    const surface = (start: string) => {
      let files = surfaces.get(start);
      if (files) return files;
      files = new Set([start]);
      const queue = [start];
      while (queue.length > 0) {
        for (const next of index.wildcardTargets(queue.shift()!)) {
          if (!files.has(next)) {
            files.add(next);
            queue.push(next);
          }
        }
      }
      surfaces.set(start, files);
      return files;
    };
    for (const edge of imports) {
      if (!edge.target) continue;
      if (edge.isReExport) {
        for (const declaration of exportable) {
          if (edge.namespaceExport && surface(edge.target).has(declaration.file)) {
            add(declaration, { kind: "re-export", file: edge.file, line: edge.line, detail: `export * as ${edge.namespaceExport}`, possible: true });
          }
          const named = edge.reExports.find((entry) => index.resolve(edge.target!, entry.imported).declarations.includes(declaration));
          if (named) {
            add(declaration, { kind: "re-export", file: edge.file, line: edge.line, detail: named.exported === named.imported ? named.exported : `${named.imported} as ${named.exported}` });
          } else if (edge.isWildcard && !edge.namespaceExport && index.resolve(edge.target, declaration.name).declarations.includes(declaration)) {
            add(declaration, { kind: "re-export", file: edge.file, line: edge.line, detail: "export *" });
          }
        }
        continue;
      }
      const importKind = edge.isTypeOnly ? "type-import" : "import";
      if (edge.bindings.length === 0 && edge.isDynamic) {
        for (const declaration of exportable) {
          if (surface(edge.target).has(declaration.file)) add(declaration, { kind: "dynamic-import", file: edge.file, line: edge.line, detail: edge.source, possible: true });
        }
        continue;
      }
      for (const binding of edge.bindings) {
        const namespace = binding.kind === "namespace" || (edge.isCjs && binding.imported === "default");
        for (const declaration of exportable) {
          if (namespace) {
            if (surface(edge.target).has(declaration.file)) {
              add(declaration, { kind: "namespace-import", file: edge.file, line: edge.line, detail: `${binding.local} from ${edge.source}`, possible: true });
            }
            continue;
          }
          const resolution = index.resolve(edge.target, binding.imported);
          if (resolution.declarations.includes(declaration)) {
            add(declaration, { kind: importKind, file: edge.file, line: edge.line, detail: binding.local === binding.imported ? binding.imported : `${binding.imported} as ${binding.local}` });
          } else if (resolution.namespaces.some((namespaceFile) => surface(namespaceFile).has(declaration.file))) {
            add(declaration, { kind: "namespace-import", file: edge.file, line: edge.line, detail: `${binding.local} from ${edge.source}`, possible: true });
          }
        }
      }
    }
  }

  const functionIds = targets.filter((declaration) => declaration.kind === "function" || declaration.kind === "method").map((declaration) => declaration.id);
  const classIds = targets.filter((declaration) => declaration.kind === "class").map((declaration) => declaration.id);
  const interfaceIds = targets.filter((declaration) => declaration.kind === "interface").map((declaration) => declaration.id);
  const [calls, moduleCalls, callbacks, routes, entrypoints, subclasses, implementations, injections] = await Promise.all([
    query(engine, functionIds, `
      MATCH (caller:Function)-[:CALLS]->(call:Call)-[:CALL_RESOLVES_TO]->(fn:Function)
      WHERE id(fn) IN $ids
      RETURN id(fn) AS target, id(caller) AS caller, call.line AS line, call.expression AS expression
    `),
    query(engine, functionIds, `
      MATCH (file:File)-[:MODULE_CALLS]->(call:Call)-[:CALL_RESOLVES_TO]->(fn:Function)
      WHERE id(fn) IN $ids
      RETURN id(fn) AS target, file.relativePath AS file, call.line AS line, call.expression AS expression
    `),
    query(engine, functionIds, `
      MATCH (fn:Function)-[:PASSED_TO]->(call:Call)
      WHERE id(fn) IN $ids
      OPTIONAL MATCH (caller:Function)-[:CALLS]->(call)
      OPTIONAL MATCH (file:File)-[:MODULE_CALLS]->(call)
      RETURN id(fn) AS target, id(caller) AS caller, file.relativePath AS file, call.line AS line, call.expression AS expression
    `),
    query(engine, functionIds, `
      MATCH (file:File)-[:DECLARES_ROUTE]->(route:Route)-[rel:ROUTE_HANDLED_BY|ROUTE_LIFECYCLE_STEP]->(fn:Function)
      WHERE id(fn) IN $ids
      RETURN id(fn) AS target, file.relativePath AS file, route.line AS line, route.method AS method,
        coalesce(route.fullPath, route.path) AS path, label(rel) AS relType, rel.role AS role
    `),
    query(engine, functionIds, `
      MATCH (file:File)-[:DECLARES_ENTRYPOINT]->(entrypoint:EntryPoint)-[:ENTRYPOINT_HANDLED_BY]->(fn:Function)
      WHERE id(fn) IN $ids
      RETURN id(fn) AS target, file.relativePath AS file, entrypoint.line AS line, entrypoint.kind AS entrypointKind,
        entrypoint.trigger AS trigger
    `),
    query(engine, classIds, `
      MATCH (file:File)-[:DEFINES_CLASS]->(sub:Class)-[:EXTENDS]->(base:Class)
      WHERE id(base) IN $ids
      RETURN id(base) AS target, sub.name AS name, file.relativePath AS file, sub.line AS line
    `),
    query(engine, interfaceIds, `
      MATCH (file:File)-[:DEFINES_CLASS]->(cls:Class)-[:IMPLEMENTS]->(iface:Interface)
      WHERE id(iface) IN $ids
      RETURN id(iface) AS target, cls.name AS name, file.relativePath AS file, cls.line AS line
    `),
    query(engine, classIds, `
      MATCH (file:File)-[:DEFINES_CLASS]->(consumer:Class)-[rel:INJECTS]->(cls:Class)
      WHERE id(cls) IN $ids
      RETURN id(cls) AS target, consumer.name AS name, file.relativePath AS file, consumer.line AS line, rel.fieldName AS fieldName
    `),
  ]);

  const callers = await loadFunctions(engine, [...new Set([...calls, ...callbacks].map((row) => String(row.caller ?? "")).filter(Boolean))]);
  const callerName = (id: unknown) => {
    const info = callers.get(String(id));
    return info ? (info.className ? `${info.className}.${info.name}` : info.name) : undefined;
  };
  const target = (row: Row) => byId.get(String(row.target));
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const line = (value: unknown) => (typeof value === "number" ? value : null);

  for (const row of calls) {
    add(target(row), { kind: "call", file: callers.get(String(row.caller))?.file ?? "", line: line(row.line), from: callerName(row.caller), detail: text(row.expression) });
  }
  for (const row of moduleCalls) {
    add(target(row), { kind: "call", file: String(row.file), line: line(row.line), from: "(module)", detail: text(row.expression) });
  }
  for (const row of callbacks) {
    add(target(row), {
      kind: "callback",
      file: text(row.file) ?? callers.get(String(row.caller))?.file ?? "",
      line: line(row.line),
      from: row.caller ? callerName(row.caller) : "(module)",
      detail: text(row.expression),
    });
  }
  for (const row of routes) {
    const role = row.relType === "ROUTE_HANDLED_BY" ? "handler" : String(row.role ?? "lifecycle");
    add(target(row), { kind: "route", file: String(row.file), line: line(row.line), from: `${String(row.method ?? "").toUpperCase()} ${String(row.path ?? "")}`.trim(), detail: role });
  }
  for (const row of entrypoints) {
    add(target(row), { kind: "entrypoint", file: String(row.file), line: line(row.line), from: `${String(row.entrypointKind ?? "")} ${String(row.trigger ?? "")}`.trim(), detail: "handler" });
  }
  for (const [rows, referenceKind] of [[subclasses, "extends"], [implementations, "implements"], [injections, "injects"]] as const) {
    for (const row of rows) {
      add(target(row), { kind: referenceKind, file: String(row.file), line: line(row.line), from: text(row.name), ...(row.fieldName ? { detail: String(row.fieldName) } : {}) });
    }
  }

  // ROUTE_HANDLED_BY also links route-level middleware, so a function with a
  // lifecycle step keeps the step's role.
  const byKey = new Map<string, Reference>();
  for (const reference of references) {
    const key = JSON.stringify({ ...reference, detail: reference.kind === "route" ? undefined : reference.detail });
    const existing = byKey.get(key);
    if (!existing || (existing.kind === "route" && existing.detail === "handler")) byKey.set(key, reference);
  }
  const unique = [...byKey.values()];
  unique.sort((a, b) => byFileAndLine(a, b) || a.kind.localeCompare(b.kind));
  const counts: Record<string, number> = {};
  for (const reference of unique) counts[reference.kind] = (counts[reference.kind] ?? 0) + 1;

  return {
    symbol,
    declarations: targets.slice(0, MAX_DECLARATIONS).map((declaration) => ({ ...describeDeclaration(declaration), isExported: declaration.isExported })),
    ...(targets.length > MAX_DECLARATIONS ? { moreDeclarations: targets.length - MAX_DECLARATIONS } : {}),
    total: unique.length,
    counts,
    references: window.take(unique),
    note: "Calls come from resolved call edges, so calls the scanner could not resolve are missing; possible: true marks namespace and dynamic imports that may not use the declaration.",
  };
}

async function query(engine: IQueryEngine, ids: readonly string[], cypher: string): Promise<Row[]> {
  return ids.length === 0 ? [] : engine.query(cypher, { ids: [...ids] }) as Promise<Row[]>;
}

// `.btn`, `#hero` and `--color-brand`: the rules that select the class or id,
// and the components, functions and files that use it (`possible: true` for a
// class matched by name only, from a sheet the file does not import).
async function findStyleReferences(engine: IQueryEngine, symbol: string, file: string | undefined, window: PageWindow) {
  const targets = await loadStyleTargets(engine, symbol, file);
  if (targets.length === 0) {
    return { symbol, declarations: [], note: "No class, id or custom property matched. Use search_symbols for a fuzzy search." };
  }
  const several = targets.length > 1;
  const byId = new Map(targets.map((target) => [target.id, target]));
  const label = (id: string) => (several ? { target: `${byId.get(id)?.file}:${byId.get(id)?.line ?? "?"}` } : {});
  const { uses, rules } = await loadStyleUses(engine, targets.map((target) => target.id));
  const references: Reference[] = [
    ...rules.map((row): Reference => ({
      kind: "rule",
      file: String(row.file),
      line: typeof row.line === "number" ? row.line : null,
      detail: String(row.selector ?? ""),
      ...label(String(row.style)),
    })),
    ...uses.map((use): Reference => ({
      kind: use.expression?.startsWith("var(") ? "var" : `${use.as}-use`,
      file: use.file ?? "",
      line: use.line,
      ...(use.as === "file" ? {} : { from: use.name }),
      detail: [use.expression, use.match ? `${use.match} match` : null].filter(Boolean).join(", "),
      ...(use.match === "name" ? { possible: true as const } : {}),
      ...label(use.style),
    })),
  ];
  references.sort((a, b) => byFileAndLine(a, b) || a.kind.localeCompare(b.kind));
  const counts: Record<string, number> = {};
  for (const reference of references) counts[reference.kind] = (counts[reference.kind] ?? 0) + 1;
  return {
    symbol,
    declarations: targets.slice(0, MAX_DECLARATIONS).map(describeStyle),
    total: references.length,
    counts,
    references: window.take(references),
    note: "rule: a rule whose selector holds the class or id; component-use, function-use and file-use: className, class, :class, styles.x and var() uses. match module is exact; import and name match by class name only, and possible: true marks name matches from a sheet the file does not import.",
  };
}
