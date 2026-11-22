import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import { projectOfFile, visibleProjects } from "./project/index.js";
import type { CSharpProject } from "./project/types.js";
import { hasUnresolvedReferences, ownerProjects } from "./owner-projects.js";
import { csharpNamespaceIndexOf, csharpProjectModelOf, setCSharpNamespaceIndex, type CSharpNamespaceIndex } from "./project.js";

// The namespace index of a C# scan plus everything the `using` directives add on top of it.
//
// Decisions:
// - `namespaces` holds every declared namespace and all its ancestors (`A.B.C` makes `A.B` and `A` known), sorted.
// - `filesOf(ns)` is only the files that declare `ns` themselves: an ancestor-only namespace (nobody wrote
//   `namespace A`) maps to NO files. A directory is irrelevant: one namespace spans files in any folders.
// - `typeIdsIn(ns)` is the top-level types declared in `ns` ("" = global namespace); a `partial` type is one id.
// - The global namespace "" is not in `namespaces`; `typeIdsIn("")` still answers for it.

export type CSharpUsing = {
  fileId: string;
  importId: string;
  /** Dotted target as written (generics stripped), `global::` removed. */
  source: string;
  kind: "normal" | "static" | "alias";
  alias: string | undefined;
  isGlobal: boolean;
  /** Enclosing namespace full name of a `using` inside a namespace block, "" at file level. */
  scope: string;
  /** First and last line of the namespace block the `using` is written in (absent at file level and for `global using`). */
  scopeStart: number | undefined;
  scopeEnd: number | undefined;
  /** Generic arguments the target of an alias was written with (`using IntBox = N.Box<int>;` is 1). */
  arity: number | undefined;
  /** `source` resolved to a declared namespace/type name (scope-relative candidates tried), else `source`. */
  target: string;
  targetKind: "namespace" | "type" | "external";
  /** Files the using reaches: declaring files of the namespace, or of the type (all files of a partial). */
  fileIds: readonly string[];
};

export type CSharpUsingsInScope = {
  /** Namespaces searched for a simple type name, in lookup order: the enclosing chain (innermost first, ending
   *  with "" for the global namespace), then namespace usings (scoped, file, global). Includes external names. */
  namespaces: string[];
  /** alias -> resolved target (namespace or type qualified name, or the written name when external). */
  aliases: Map<string, string>;
  /** Qualified names of the types whose static members are in scope (`using static`). */
  staticTypes: string[];
};

/** The outcome of one `using`. `expected`: finding no file counts as unresolved. */
export type CSharpUsingResolution = Pick<CSharpUsing, "target" | "targetKind" | "fileIds"> & { expected: boolean };

/** True when `using` counts at `line`: a `using` in a namespace block only counts inside that block (no line: anywhere its namespace is). */
export function usingAppliesAt(using: Pick<CSharpUsing, "scopeStart" | "scopeEnd">, line: number | undefined): boolean {
  return line === undefined || using.scopeStart === undefined || using.scopeEnd === undefined || (line >= using.scopeStart && line <= using.scopeEnd);
}

export type CSharpUsingShape = { source: string; kind: CSharpUsing["kind"]; scope: string };

/** The using data behind the namespace index; `usingsInScope` and the import resolver are built on it. */
export interface CSharpUsingIndex {
  /** Qualified type name (`Acme.Outer.Inner`, nested allowed) -> Class/Interface ids; a partial id appears once. */
  typeIdsByName(qualifiedName: string): readonly string[];
  /** Files declaring the type (every file of a partial type). */
  typeFiles(qualifiedName: string): readonly string[];
  /** Resolves a `using`; `viewerFileId` (the file whose view applies) restricts it to the namespaces and types its project can see. */
  resolveUsing(shape: CSharpUsingShape, viewerFileId?: string): CSharpUsingResolution;
  /** True when the scan has C# projects, so visibility can hide something. */
  readonly projectScoped: boolean;
  /** Whether `targetFileId` is visible from `viewerFileId`: same project or a transitive ProjectReference; files in no project see and are seen by everything. */
  canSee(viewerFileId: string, targetFileId: string): boolean;
  /** Whether `namespace` (declared or an ancestor of one) exists in the view of `viewerFileId`. */
  hasNamespaceFor(viewerFileId: string, namespace: string): boolean;
  /** The `global using`s that apply to `fileId`: those written in files of its project (of the project-less files for a file in no project), then the project's model usings (SDK implicit and `<Using>` items). */
  globalUsingsFor(fileId: string): readonly CSharpUsing[];
  /** All usings of the scan in (file id, import id) order, resolved. */
  readonly usings: readonly CSharpUsing[];
  readonly globalUsings: readonly CSharpUsing[];
  usingsOfFile(fileId: string): readonly CSharpUsing[];
}

const PLATFORM_ROOTS = new Set(["System", "Microsoft"]);

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const extras = new WeakMap<object, CSharpUsingIndex>();

function parseJsonList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

const stripGlobal = (name: string): string => (name.startsWith("global::") ? name.slice("global::".length) : name);

/** `A.B` -> ["A.B", "A"]; "" -> []. */
function enclosingChain(namespace: string): string[] {
  const chain: string[] = [];
  let current = namespace;
  while (current !== "") {
    chain.push(current);
    const dot = current.lastIndexOf(".");
    current = dot < 0 ? "" : current.slice(0, dot);
  }
  return chain;
}

/** Names a `using` target can denote from inside `scope`: relative to each enclosing namespace, then absolute. */
const candidates = (source: string, scope: string): string[] => [...enclosingChain(scope).map((ns) => `${ns}.${source}`), source];

export function buildCSharpNamespaceIndex(graph: IGraphContributor): CSharpNamespaceIndex {
  const declaredBy = new Map<string, string[]>();
  const fileSet = new Set<string>();
  for (const node of graph.nodesWithLabel("File")) {
    if (node.properties.language !== "csharp") continue;
    fileSet.add(node.id);
    for (const namespace of parseJsonList(node.properties.csharpNamespaces)) {
      const files = declaredBy.get(namespace) ?? [];
      if (!files.includes(node.id)) files.push(node.id);
      declaredBy.set(namespace, files);
    }
  }
  // Projects: the project of each file and what each project sees, computed once per scan.
  const model = csharpProjectModelOf(graph);
  const projectScoped = model.projects.length > 0;
  // Ownership uses only the projects the manifest declares (one per directory), so scoping and Package nodes agree.
  const owners = ownerProjects(model);
  const ownerModel = { ...model, projects: owners };
  const ownerByDir = new Map(owners.map((project) => [project.dir, project]));
  const projectByFileId = new Map<string, CSharpProject | undefined>();
  const projectKey = (fileId: string): string => {
    if (!projectScoped) return "";
    let project = projectByFileId.get(fileId);
    if (project === undefined && !projectByFileId.has(fileId)) {
      const relative = graph.node(fileId)?.properties.relativePath;
      project = typeof relative === "string" ? projectOfFile(ownerModel, relative) : undefined;
      projectByFileId.set(fileId, project);
    }
    return project?.file ?? "";
  };
  // A reference may name a project that does not own its directory: it stands for the directory's owner.
  const visibleOf = new Map<string, Set<string>>();
  for (const project of owners) {
    const visible = new Set<string>();
    for (const file of visibleProjects(model, project.file)) {
      const named = model.projects.find((candidate) => candidate.file === file);
      visible.add(named ? (ownerByDir.get(named.dir)?.file ?? file) : file);
    }
    visibleOf.set(project.file, visible);
  }
  // A project with a ProjectReference the reader could not expand or find (`$(SolutionDir)`, a missing target) may
  // reference anything, so it sees everything (as without projects). Only the viewer's own flag matters: a flag deeper
  // in its reference closure keeps the viewer scoped to what it could resolve.
  const sawEverything = new Set(owners.filter(hasUnresolvedReferences).map((project) => project.file));
  const canSee = (viewerFileId: string, targetFileId: string): boolean => {
    if (!projectScoped) return true;
    const viewer = projectKey(viewerFileId);
    if (viewer === "" || sawEverything.has(viewer)) return true;
    const target = projectKey(targetFileId);
    return target === "" || target === viewer || (visibleOf.get(viewer)?.has(target) ?? false);
  };

  const known = new Set<string>();
  for (const namespace of declaredBy.keys()) for (const part of enclosingChain(namespace)) known.add(part);
  const namespaces = [...known].sort(byText);
  const roots = new Set(namespaces.map((namespace) => namespace.split(".")[0]!));

  const typeNodes = new Map<string, { qualifiedName: string; namespace: string; topLevel: boolean }>();
  for (const label of ["Class", "Interface"] as const) {
    for (const node of graph.nodesWithLabel(label)) {
      const p = node.properties;
      if (typeof p.qualifiedName !== "string" || typeof p.namespace !== "string") continue;
      typeNodes.set(node.id, { qualifiedName: p.qualifiedName, namespace: p.namespace, topLevel: p.nesting === "top-level" });
    }
  }
  const idsByName = new Map<string, string[]>();
  const filesByName = new Map<string, string[]>();
  const idsByNamespace = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, id: string): void => {
    const list = map.get(key) ?? [];
    if (!list.includes(id)) list.push(id);
    map.set(key, list);
  };
  for (const [id, type] of typeNodes) {
    add(idsByName, type.qualifiedName, id);
    if (type.topLevel) add(idsByNamespace, type.namespace, id);
  }
  for (const relType of ["DEFINES_CLASS", "DEFINES_INTERFACE"] as const) {
    for (const rel of graph.relationshipsOfType(relType)) {
      const type = typeNodes.get(rel.to);
      if (type !== undefined && fileSet.has(rel.from)) add(filesByName, type.qualifiedName, rel.from);
    }
  }
  for (const map of [idsByName, filesByName, idsByNamespace]) for (const list of map.values()) list.sort(byText);

  const index: CSharpNamespaceIndex = {
    namespaces,
    hasNamespace: (namespace) => known.has(namespace),
    filesOf: (namespace) => [...(declaredBy.get(namespace) ?? [])].sort(byText),
    typeIdsIn: (namespace) => idsByNamespace.get(namespace) ?? [],
  };

  const importerOf = new Map<string, string>();
  for (const rel of graph.relationshipsOfType("IMPORTS")) if (fileSet.has(rel.from)) importerOf.set(rel.to, rel.from);
  const isProjectRoot = (name: string): boolean => {
    const root = name.split(".")[0]!;
    return roots.has(root) && !PLATFORM_ROOTS.has(root);
  };
  const typeFiles = (name: string): readonly string[] => filesByName.get(name) ?? [];

  // The namespaces one project sees, built once per project on first use. Files in no project see everything.
  type View = { declared: Map<string, string[]>; known: Set<string> };
  const fullView: View = { declared: declaredBy, known };
  const views = new Map<string, View>();
  const viewOfKey = (key: string): View => {
    if (key === "" || sawEverything.has(key)) return fullView;
    let view = views.get(key);
    if (!view) {
      const visible = visibleOf.get(key);
      const declared = new Map<string, string[]>();
      const knownHere = new Set<string>();
      for (const [namespace, files] of declaredBy) {
        const kept = files.filter((id) => {
          const target = projectKey(id);
          return target === "" || target === key || (visible?.has(target) ?? false);
        });
        if (kept.length === 0) continue;
        declared.set(namespace, kept);
        for (const part of enclosingChain(namespace)) knownHere.add(part);
      }
      views.set(key, view = { declared, known: knownHere });
    }
    return view;
  };
  const viewOfFile = (fileId: string | undefined): View => (fileId === undefined ? fullView : viewOfKey(projectKey(fileId)));
  const visibleTypeFiles = (name: string, viewer: string | undefined): readonly string[] => {
    const files = typeFiles(name);
    return viewer === undefined || !projectScoped ? files : files.filter((id) => canSee(viewer, id));
  };

  const resolveUsing = ({ source, kind, scope }: CSharpUsingShape, viewerFileId?: string): CSharpUsingResolution => {
    const written = stripGlobal(source);
    const view = viewOfFile(viewerFileId);
    for (const name of candidates(written, scope)) {
      // `using X;` names a namespace, `using static X.Y;` a type, an alias either.
      const files = kind !== "static" ? view.declared.get(name) : undefined;
      if (files !== undefined) return { target: name, targetKind: "namespace", fileIds: [...files].sort(byText), expected: true };
      if (kind !== "normal" && idsByName.has(name)) {
        const here = visibleTypeFiles(name, viewerFileId);
        if (here.length > 0 || !projectScoped) return { target: name, targetKind: "type", fileIds: here, expected: true };
      }
      // Ancestor-only namespace: real, but no file declares it. Not an error and no file.
      if (kind !== "static" && view.known.has(name)) return { target: name, targetKind: "namespace", fileIds: [], expected: false };
    }
    // Declared nowhere (or only in a project this one cannot see): a name under the scan's own root namespace counts
    // as unresolved; System, Microsoft and foreign roots (NuGet packages) are external.
    return { target: written, targetKind: "external", fileIds: [], expected: isProjectRoot(written) };
  };

  const usings: CSharpUsing[] = [];
  for (const node of graph.nodesWithLabel("Import")) {
    const fileId = importerOf.get(node.id);
    const p = node.properties;
    if (fileId === undefined || typeof p.source !== "string") continue;
    const kind = p.importKind === "static" || p.importKind === "alias" ? p.importKind : "normal";
    const scope = typeof p.usingScope === "string" ? p.usingScope : "";
    const resolution = resolveUsing({ source: p.source, kind, scope }, fileId);
    usings.push({
      fileId,
      importId: node.id,
      source: stripGlobal(p.source),
      kind,
      alias: typeof p.alias === "string" && p.alias !== "" ? p.alias : undefined,
      isGlobal: p.isGlobal === true,
      scope,
      scopeStart: typeof p.usingScopeStart === "number" ? p.usingScopeStart : undefined,
      scopeEnd: typeof p.usingScopeEnd === "number" ? p.usingScopeEnd : undefined,
      arity: typeof p.sourceArity === "number" ? p.sourceArity : undefined,
      target: resolution.target,
      targetKind: resolution.targetKind,
      fileIds: resolution.fileIds,
    });
  }
  usings.sort((a, b) => byText(a.fileId, b.fileId) || byText(a.importId, b.importId));
  const byFile = new Map<string, CSharpUsing[]>();
  for (const using of usings) {
    const list = byFile.get(using.fileId) ?? [];
    list.push(using);
    byFile.set(using.fileId, list);
  }
  // `global using`s per project (key "" = files in no project): written in a file of the project, then the model's
  // `usings`. Computed once per project.
  const firstFileByKey = new Map<string, string>();
  for (const id of fileSet) {
    const key = projectKey(id);
    if (key !== "" && !firstFileByKey.has(key)) firstFileByKey.set(key, id);
  }
  const globalsByKey = new Map<string, CSharpUsing[]>();
  const globalsOfKey = (key: string): CSharpUsing[] => {
    const cached = globalsByKey.get(key);
    if (cached) return cached;
    const list = usings.filter((using) => using.isGlobal && projectKey(using.fileId) === key);
    const project = key === "" ? undefined : owners.find((candidate) => candidate.file === key);
    (project?.usings ?? []).forEach((entry, position) => {
      const kind = entry.static ? "static" : entry.alias !== null ? "alias" : "normal";
      const resolution = resolveUsing({ source: entry.namespace, kind, scope: "" }, firstFileByKey.get(key));
      list.push({
        fileId: key,
        importId: `csharp:project-using:${key}:${position}`,
        source: entry.namespace,
        kind,
        alias: entry.alias ?? undefined,
        isGlobal: true,
        scope: "",
        scopeStart: undefined,
        scopeEnd: undefined,
        arity: undefined,
        target: resolution.target,
        targetKind: resolution.targetKind,
        fileIds: resolution.fileIds,
      });
    });
    globalsByKey.set(key, list);
    return list;
  };

  extras.set(index, {
    projectScoped,
    canSee,
    hasNamespaceFor: (viewerFileId, namespace) => viewOfFile(viewerFileId).known.has(namespace),
    globalUsingsFor: (fileId) => globalsOfKey(projectKey(fileId)),
    typeIdsByName: (name) => idsByName.get(name) ?? [],
    typeFiles,
    resolveUsing,
    usings,
    globalUsings: usings.filter((using) => using.isGlobal),
    usingsOfFile: (fileId) => byFile.get(fileId) ?? [],
  });
  return index;
}

/** The using data of an index built by `buildCSharpNamespaceIndex`, or of the index installed on a graph. */
export function csharpUsingIndexOf(source: IGraphContributor | CSharpNamespaceIndex): CSharpUsingIndex | undefined {
  if ("filesOf" in source) return extras.get(source);
  const installed = extras.get(csharpNamespaceIndexOf(source));
  if (installed !== undefined) return installed;
  // No index installed on this graph yet: build and install one.
  const built = buildCSharpNamespaceIndex(source);
  setCSharpNamespaceIndex(source, built);
  return extras.get(built);
}

/** `global using` directives of the scan (they apply to every C# file). */
export function globalUsingsOf(source: IGraphContributor | CSharpNamespaceIndex): readonly CSharpUsing[] {
  return csharpUsingIndexOf(source)?.globalUsings ?? [];
}

/**
 * What a simple name in `fileId`, written inside `namespace` ("" = global), can refer to through namespaces
 * and usings. A `using` in a namespace block only counts inside that block (and nested namespaces); file-level
 * and `global using` directives count everywhere.
 */
export function usingsInScope(source: IGraphContributor | CSharpNamespaceIndex, fileId: string, namespace: string, line?: number): CSharpUsingsInScope {
  const result: CSharpUsingsInScope = { namespaces: [...enclosingChain(namespace), ""], aliases: new Map(), staticTypes: [] };
  const usingIndex = csharpUsingIndexOf(source);
  if (usingIndex === undefined) return result;
  const own = usingIndex.usingsOfFile(fileId).filter(
    (using) => !using.isGlobal && (using.scope === "" || namespace === using.scope || namespace.startsWith(`${using.scope}.`)) && usingAppliesAt(using, line),
  );
  // Innermost block scope first, then file level, then global; stable within a group.
  const ordered = [
    ...own.filter((using) => using.scope !== "").sort((a, b) => b.scope.length - a.scope.length),
    ...own.filter((using) => using.scope === ""),
    ...usingIndex.globalUsingsFor(fileId),
  ];
  for (const using of ordered) {
    if (using.kind === "alias" && using.alias !== undefined) {
      if (!result.aliases.has(using.alias)) result.aliases.set(using.alias, using.target);
    } else if (using.kind === "static") {
      if (!result.staticTypes.includes(using.target)) result.staticTypes.push(using.target);
    } else if (!result.namespaces.includes(using.target)) {
      result.namespaces.push(using.target);
    }
  }
  return result;
}
