import type { IQueryEngine } from "../../core/contracts/query-engine.js";
import { optionalString } from "./args.js";
import type { PageWindow } from "./paging.js";

type Row = Record<string, unknown>;

// Readers and writers listed per store; the counts cover all of them.
const USERS_PER_STORE = 20;

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const names = (value: unknown): string[] => (typeof value === "string" ? value.split(",").filter(Boolean) : []);

// list_stores: state stores (Pinia, Redux Toolkit, Zustand, Jotai, Svelte)
// with their state, getters and actions, the functions that define them,
// and the functions that read or write them.
export async function listStores(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const name = optionalString(args.name);
  const library = optionalString(args.library);
  const file = optionalString(args.file);
  const conditions = [
    name ? "(contains(lower(store.name), lower($name)) OR contains(lower(store.hook), lower($name)))" : null,
    library ? "store.library = $library" : null,
    file ? "file.relativePath = $file" : null,
  ].filter(Boolean);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const params = { name: name ?? "", library: library ?? "", file: file ?? "" };

  const [stores, access, actions] = await Promise.all([
    engine.query(`
      MATCH (file:File)-[:DECLARES_STORE]->(store:Store) ${where}
      RETURN id(store) AS id, store.name AS name, store.library AS library, store.kind AS kind, store.hook AS hook,
        file.relativePath AS file, store.line AS line, store.state AS state, store.getters AS getters,
        store.actions AS actions, store.slices AS slices
    `, params),
    engine.query(`
      MATCH (file:File)-[:DECLARES_STORE]->(store:Store)<-[rel:READS_STORE|WRITES_STORE]-(fn:Function) ${where}
      OPTIONAL MATCH (fnFile:File)-[:DEFINES_FUNCTION]->(fn)
      RETURN id(store) AS store, id(fn) AS fn, fn.name AS function, fnFile.relativePath AS file, rel.line AS line,
        label(rel) AS relType, rel.members AS members
    `, params),
    engine.query(`
      MATCH (file:File)-[:DECLARES_STORE]->(store:Store)-[rel:STORE_ACTION|STORE_DEFINED_BY_FUNCTION]->(fn:Function) ${where}
      RETURN id(store) AS store, fn.name AS function, fn.line AS line, label(rel) AS relType
    `, params),
  ]) as Row[][];

  const result = stores!.map((store) => {
    const id = String(store.id);
    const uses = access!.filter((row) => String(row.store) === id);
    const users = (relType: string) => {
      const byFunction = new Map<string, Row & { members: Set<string> }>();
      for (const row of uses.filter((use) => use.relType === relType)) {
        const key = String(row.fn);
        const user = byFunction.get(key) ?? { function: row.function, file: row.file ?? null, line: row.line ?? null, members: new Set<string>() };
        for (const member of names(row.members)) user.members.add(member);
        byFunction.set(key, user);
      }
      return [...byFunction.values()]
        .sort((a, b) => String(a.file ?? "").localeCompare(String(b.file ?? "")) || Number(a.line ?? 0) - Number(b.line ?? 0))
        .map(({ members, ...user }) => ({ ...user, ...(members.size > 0 ? { members: [...members].sort() } : {}) }));
    };
    const readers = users("READS_STORE");
    const writers = users("WRITES_STORE");
    const own = actions!.filter((row) => String(row.store) === id);
    return {
      name: store.name,
      library: store.library,
      kind: store.kind ?? null,
      hook: store.hook ?? null,
      file: store.file,
      line: store.line ?? null,
      state: names(store.state),
      getters: names(store.getters),
      actions: names(store.actions),
      ...(str(store.slices) ? { slices: JSON.parse(String(store.slices)) as Record<string, string> } : {}),
      definedBy: own.filter((row) => row.relType === "STORE_DEFINED_BY_FUNCTION").map((row) => ({ function: row.function, line: row.line ?? null })),
      readBy: readers.length,
      writtenBy: writers.length,
      readers: readers.slice(0, USERS_PER_STORE),
      writers: writers.slice(0, USERS_PER_STORE),
    };
  }).sort((a, b) => String(a.file).localeCompare(String(b.file)) || Number(a.line ?? 0) - Number(b.line ?? 0));

  return {
    query: { name, library, file },
    totalStores: result.length,
    stores: window.take(result),
    note: `Stores come from Pinia defineStore, Redux Toolkit createSlice / configureStore, Zustand create, Jotai atoms and Svelte stores. readBy / writtenBy count distinct functions; each store lists up to ${USERS_PER_STORE} readers and writers. A Redux root store's slices map its state keys to their reducers.`,
  };
}
