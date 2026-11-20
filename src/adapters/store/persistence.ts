import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { createGunzip, gunzip, gzip } from "node:zlib";
import type { GraphNode, GraphRelationship } from "../../core/graph/model.js";
import { MemoryGraph, validateProperties, type NodeRecord, type PropertyValue, type RelationshipRecord } from "./graph.js";
import { physicalRelationshipType } from "./physical-types.js";
import { withProvenance } from "./provenance.js";
import type { GraphSchemaIndex } from "../../core/graph/schema.js";
import { schemaFingerprint } from "./schema-fingerprint.js";

/**
 * On-disk snapshot of a MemoryGraph:
 *
 *   <dir>/HEAD.json                 which segments make up the current graph
 *   <dir>/segments/<hash>.jsonl.gz  one segment per owning source file, plus "global"
 *
 * Segments are content-addressed and never overwritten, so a commit writes
 * only the segments whose content changed and then atomically renames
 * HEAD.json. Readers never lock: they read HEAD.json and the segments it names.
 */

export const STORE_FORMAT = 1;
export const GLOBAL_SEGMENT = "global";
const HEAD_FILE = "HEAD.json";
const SEGMENTS_DIR = "segments";
/** Unreferenced segments are kept this long so readers of the previous HEAD can finish. */
const SEGMENT_GRACE_MS = 60_000;
const READ_ATTEMPTS = 3;
/** Segments being hashed, compressed and written at the same time. */
const WRITE_CONCURRENCY = 4;
/** Segments being read, decompressed and parsed at the same time. */
const READ_CONCURRENCY = 8;
/** Segments larger than this (compressed) are decompressed and parsed as a stream. */
const STREAM_SEGMENT_BYTES = 1 << 20;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export type Head = {
  format: number;
  schemaVersion: number;
  /** Tables the snapshot was written for (see schemaFingerprint); heads from before it was added have none. */
  schemaFingerprint?: string;
  generation: number;
  writtenAt: string;
  nodes: number;
  relationships: number;
  /** Segment key (owning file id or "global") → segment file name. */
  segments: Record<string, string>;
};

type NodeLine = ["n", string, string, Record<string, PropertyValue>];
type RelationshipLine = ["r", string, string, string, Record<string, PropertyValue>];

export async function readHead(directory: string): Promise<Head | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(directory, HEAD_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const head = JSON.parse(raw) as Head;
  if (head.format !== STORE_FORMAT) {
    throw new Error(`Unsupported graph store format ${head.format} in ${directory}; run concentrate scan again`);
  }
  return head;
}

/**
 * Load the current snapshot, one segment at a time. A segment deleted under us
 * means a newer HEAD exists, so start over.
 *
 * A per-file segment holds nodes before relationships (lines are sorted) and
 * only relationships inside the file, so it resolves on its own. The global
 * segment holds the cross-file relationships and is loaded after all others,
 * so its relationships resolve at once too. Anything whose endpoint is still
 * missing waits in a compact list and is resolved at the end.
 */
export async function loadSnapshot(directory: string, schema: GraphSchemaIndex): Promise<{ head: Head | null; graph: MemoryGraph }> {
  for (let attempt = 1; ; attempt += 1) {
    const head = await readHead(directory);
    const graph = new MemoryGraph(schema);
    if (!head) return { head, graph };
    try {
      const pending: RelationshipLine[] = [];
      const loadSegment = async (file: string) => {
        const compressed = await readFile(path.join(directory, SEGMENTS_DIR, file));
        if (compressed.length <= STREAM_SEGMENT_BYTES) {
          addSegment(graph, (await gunzipAsync(compressed)).toString("utf8"), pending);
        } else {
          await addSegmentStreamed(graph, compressed, pending);
        }
      };
      const keys = Object.keys(head.segments);
      const files = keys.filter((key) => key !== GLOBAL_SEGMENT).map((key) => head.segments[key]!);
      await runConcurrently(files, READ_CONCURRENCY, loadSegment);
      if (head.segments[GLOBAL_SEGMENT]) await loadSegment(head.segments[GLOBAL_SEGMENT]);
      for (const [, type, from, to, properties] of pending) {
        if (!graph.addTrustedRelationship(type, from, to, properties)) {
          throw new Error(`Corrupt graph store in ${directory}: ${type} ${from} -> ${to} has a missing endpoint`);
        }
      }
      return { head, graph };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt >= READ_ATTEMPTS) throw error;
    }
  }
}

/**
 * Add the lines of one segment; relationships with a missing endpoint go to
 * `pending`. Returns the unterminated text after the last newline, which only
 * a chunk of a streamed segment has.
 */
function addSegment(graph: MemoryGraph, content: string, pending: RelationshipLine[]): string {
  let start = 0;
  for (let end = content.indexOf("\n"); end !== -1; end = content.indexOf("\n", start)) {
    if (end > start) addLine(graph, content.slice(start, end), pending);
    start = end + 1;
  }
  return content.slice(start);
}

function addLine(graph: MemoryGraph, line: string, pending: RelationshipLine[]): void {
  const record = JSON.parse(line) as NodeLine | RelationshipLine;
  if (record[0] === "n") graph.addTrustedNode(record[1], record[2], record[3]);
  else if (!graph.addTrustedRelationship(record[1], record[2], record[3], record[4])) pending.push(record);
}

/**
 * Decompress and add a large segment chunk by chunk, so neither its whole
 * text nor its decompressed bytes exist at once (the global segment of a
 * 17,000-file repository is 136 MB of text).
 */
async function addSegmentStreamed(graph: MemoryGraph, compressed: Buffer, pending: RelationshipLine[]): Promise<void> {
  const decoder = new StringDecoder("utf8");
  const gunzipStream = createGunzip();
  gunzipStream.end(compressed);
  let rest = "";
  for await (const chunk of gunzipStream as AsyncIterable<Buffer>) {
    rest = addSegment(graph, rest + decoder.write(chunk), pending);
  }
  rest += decoder.end();
  if (rest) addLine(graph, rest, pending);
}

/** Run `task` for every item with at most `limit` in flight. */
async function runConcurrently<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Write `graph` as the next generation. The caller holds the writer lock. */
export async function commitSnapshot(
  directory: string,
  graph: MemoryGraph,
  options: { previous: Head | null },
): Promise<Head> {
  const segmentsDirectory = path.join(directory, SEGMENTS_DIR);
  await mkdir(segmentsDirectory, { recursive: true });
  const reusable = reusableSegments(options.previous);
  const segments: Record<string, string> = {};
  for (const [key, content] of serializeSegments(graph)) {
    segments[key] = await writeSegment(segmentsDirectory, content, reusable);
  }
  return writeHead(directory, segments, { nodes: graph.nodeCount, relationships: graph.relationshipCount }, { schema: graph.schema, previous: options.previous });
}

/**
 * Write a scanned graph as the next generation without building a MemoryGraph:
 * the snapshot is produced segment by segment straight from the arrays, so
 * only a few segments' text exist at a time. The files and HEAD are identical
 * to what `commitSnapshot` of `MemoryGraph.write(nodes, relationships)` writes.
 * The caller holds the writer lock. On failure HEAD is left untouched.
 */
export async function commitScannedSnapshot(
  directory: string,
  nodes: readonly GraphNode[],
  relationships: readonly GraphRelationship[],
  options: { schema: GraphSchemaIndex; previous: Head | null },
): Promise<Head> {
  const { schema } = options;
  const plan = planSegments(nodes, relationships, schema);
  const segmentsDirectory = path.join(directory, SEGMENTS_DIR);
  await mkdir(segmentsDirectory, { recursive: true });
  const reusable = reusableSegments(options.previous);

  const keys = [...new Set([...plan.nodesByKey.keys(), ...plan.relationshipsByKey.keys()])].sort();
  const files = new Map<string, string>();
  await runConcurrently(keys, WRITE_CONCURRENCY, async (key) => {
    const lines: string[] = [];
    for (const index of plan.nodesByKey.get(key) ?? []) {
      const node = nodes[index]!;
      const table = schema.nodeTableByLabel.get(node.label)!;
      lines.push(JSON.stringify(["n", node.label, node.id, validateProperties(`node ${node.id}`, table.properties, node.properties)] satisfies NodeLine));
    }
    for (const index of plan.relationshipsByKey.get(key) ?? []) {
      const relationship = relationships[index]!;
      const type = plan.types[index]!;
      const table = schema.relationshipTableByType.get(type)!;
      const properties = validateProperties(`${type} ${relationship.from} -> ${relationship.to}`, table.properties, withProvenance(relationship));
      lines.push(JSON.stringify(["r", type, relationship.from, relationship.to, properties] satisfies RelationshipLine));
    }
    files.set(key, await writeSegment(segmentsDirectory, `${lines.sort().join("\n")}\n`, reusable));
  });

  const segments: Record<string, string> = {};
  for (const key of keys) segments[key] = files.get(key)!;
  return writeHead(directory, segments, { nodes: nodes.length, relationships: plan.kept }, options);
}

type SegmentPlan = {
  nodesByKey: Map<string, number[]>;
  relationshipsByKey: Map<string, number[]>;
  /** Physical type per relationship index; undefined for dropped ones. */
  types: (string | undefined)[];
  kept: number;
};

/**
 * Decide, with the same checks as `MemoryGraph.write`, which segment every
 * node and kept relationship belongs to. Holds indexes, not copies.
 */
function planSegments(nodes: readonly GraphNode[], relationships: readonly GraphRelationship[], schema: GraphSchemaIndex): SegmentPlan {
  const indexById = new Map<string, number>();
  const fileKeys = new Map<string, string>();
  nodes.forEach((node, index) => {
    if (!schema.nodeTableByLabel.has(node.label)) {
      throw new Error(`Cannot write node ${node.id}: table ${node.label} does not exist`);
    }
    if (indexById.has(node.id)) {
      throw new Error(`Cannot write node ${node.id}: duplicate primary key`);
    }
    indexById.set(node.id, index);
    if (node.label === "File") fileKeys.set(node.id, node.id);
  });

  const owners: string[] = new Array(nodes.length);
  const nodesByKey = new Map<string, number[]>();
  nodes.forEach((node, index) => {
    const key = owningFile(node.id, fileKeys) ?? GLOBAL_SEGMENT;
    owners[index] = key;
    pushTo(nodesByKey, key, index);
  });

  // physicalRelationshipType only ever calls `.get` on the label map.
  const labelById = {
    get: (id: string) => {
      const index = indexById.get(id);
      return index === undefined ? undefined : nodes[index]!.label;
    },
  } as unknown as Map<string, GraphNode["label"]>;

  const relationshipsByKey = new Map<string, number[]>();
  const types: (string | undefined)[] = new Array(relationships.length);
  let kept = 0;
  relationships.forEach((relationship, index) => {
    const requested = physicalRelationshipType(relationship, labelById);
    const table = schema.relationshipTableByType.get(requested);
    if (!table) {
      throw new Error(`Cannot write relationship ${relationship.from} -> ${relationship.to}: table ${requested} does not exist`);
    }
    const fromIndex = indexById.get(relationship.from);
    const toIndex = indexById.get(relationship.to);
    if (fromIndex === undefined || toIndex === undefined) return;
    const fromLabel = nodes[fromIndex]!.label;
    const toLabel = nodes[toIndex]!.label;
    if (fromLabel !== table.from || toLabel !== table.to) {
      throw new Error(`Cannot write ${table.type} from ${fromLabel} ${relationship.from} to ${toLabel} ${relationship.to}: expected ${table.from} -> ${table.to}`);
    }
    types[index] = table.type;
    kept += 1;
    const from = owners[fromIndex]!;
    pushTo(relationshipsByKey, from === owners[toIndex] ? from : GLOBAL_SEGMENT, index);
  });
  return { nodesByKey, relationshipsByKey, types, kept };
}

function pushTo(map: Map<string, number[]>, key: string, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function reusableSegments(previous: Head | null): ReadonlySet<string> {
  return new Set(previous ? Object.values(previous.segments) : []);
}

/** Hash, compress and write one segment unless the previous HEAD already has it. Returns its file name. */
async function writeSegment(segmentsDirectory: string, content: string, reusable: ReadonlySet<string>): Promise<string> {
  const file = `${createHash("sha256").update(content).digest("hex").slice(0, 32)}.jsonl.gz`;
  if (reusable.has(file)) return file;
  const target = path.join(segmentsDirectory, file);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, await gzipAsync(content));
  await rename(temporary, target);
  return file;
}

/** Publish `segments` as the next generation: atomically replace HEAD.json, then collect garbage. */
async function writeHead(
  directory: string,
  segments: Record<string, string>,
  counts: { nodes: number; relationships: number },
  options: { schema: GraphSchemaIndex; previous: Head | null },
): Promise<Head> {
  const head: Head = {
    format: STORE_FORMAT,
    schemaVersion: options.schema.version,
    schemaFingerprint: schemaFingerprint(options.schema),
    generation: (options.previous?.generation ?? 0) + 1,
    writtenAt: new Date().toISOString(),
    nodes: counts.nodes,
    relationships: counts.relationships,
    segments,
  };
  const headPath = path.join(directory, HEAD_FILE);
  const temporary = `${headPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(head, null, 2)}\n`);
  await rename(temporary, headPath);

  await collectGarbage(path.join(directory, SEGMENTS_DIR), new Set(Object.values(segments)));
  return head;
}

async function collectGarbage(segmentsDirectory: string, referenced: ReadonlySet<string>): Promise<void> {
  const now = Date.now();
  for (const file of await readdir(segmentsDirectory)) {
    if (referenced.has(file)) continue;
    const target = path.join(segmentsDirectory, file);
    try {
      if (now - (await stat(target)).mtimeMs > SEGMENT_GRACE_MS) await unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * Split the graph into segments: what each file owns (its File node, every
 * node whose id starts with `<file id>:`, and relationships inside the file),
 * plus one global segment for everything else. Lines are sorted so equal
 * content always hashes the same, whatever the insertion order.
 */
export function serializeSegments(graph: MemoryGraph): Map<string, string> {
  const fileIds = new Set([...graph.nodesWithLabel("File")].map((node) => node.id));
  const ownerCache = new Map<NodeRecord, string>();
  const owner = (node: NodeRecord): string => {
    let key = ownerCache.get(node);
    if (key === undefined) {
      key = owningFile(node.id, fileIds) ?? GLOBAL_SEGMENT;
      ownerCache.set(node, key);
    }
    return key;
  };

  const lines = new Map<string, string[]>();
  const add = (key: string, line: string) => {
    let list = lines.get(key);
    if (!list) lines.set(key, list = []);
    list.push(line);
  };
  for (const node of graph.nodes()) {
    add(owner(node), JSON.stringify(["n", node.label, node.id, node.properties] satisfies NodeLine));
  }
  for (const relationship of graph.relationships()) {
    const from = owner(relationship.from);
    add(from === owner(relationship.to) ? from : GLOBAL_SEGMENT, relationshipLine(relationship));
  }

  const segments = new Map<string, string>();
  for (const key of [...lines.keys()].sort()) {
    segments.set(key, `${lines.get(key)!.sort().join("\n")}\n`);
  }
  return segments;
}

function relationshipLine(relationship: RelationshipRecord): string {
  return JSON.stringify([
    "r", relationship.type, relationship.from.id, relationship.to.id, relationship.properties,
  ] satisfies RelationshipLine);
}

/** The longest File id that equals `id` or is followed by `:` in it. */
function owningFile(id: string, fileIds: ReadonlyMap<string, string> | ReadonlySet<string>): string | undefined {
  if (fileIds.has(id)) return fileIds instanceof Map ? fileIds.get(id) : id;
  if (!id.startsWith("file:")) return undefined;
  for (let index = id.lastIndexOf(":"); index > "file:".length - 1; index = id.lastIndexOf(":", index - 1)) {
    const candidate = id.slice(0, index);
    if (fileIds.has(candidate)) return fileIds instanceof Map ? fileIds.get(candidate) : candidate;
  }
  return undefined;
}
