import { withSyntaxTree, type SyntaxNode } from "../../languages/syntax/tree-sitter.js";

// A small reader for the YAML of compose files and CI workflows, on the
// vendored yaml grammar: mappings, sequences, flow collections, quoted and
// block scalars, anchors, aliases and `<<` merges, with the line of every
// key and item. It reads values as text (no `true` / `1` typing), the first
// document only, and gives up (null) on a file with syntax errors.

export type YScalar = { type: "scalar"; text: string; line: number };
export type YMap = { type: "map"; entries: Array<{ key: string; line: number; value: YValue }> };
export type YSeq = { type: "seq"; items: Array<{ value: YValue; line: number }> };
export type YValue = YScalar | YMap | YSeq | null;

export async function readYaml(source: string): Promise<YValue> {
  return withSyntaxTree("yaml", source, (tree) => {
    if (tree.rootNode.hasError) return null;
    const document = tree.rootNode.namedChildren.find((child) => child.type === "document");
    const body = document?.namedChildren.find((child) => child.type !== "comment");
    return body ? convert(body, new Map()) : null;
  });
}

export function asMap(value: YValue | undefined): YMap | null {
  return value?.type === "map" ? value : null;
}

export function asSeq(value: YValue | undefined): YSeq | null {
  return value?.type === "seq" ? value : null;
}

export function asText(value: YValue | undefined): string | null {
  return value?.type === "scalar" ? value.text : null;
}

export function mapGet(map: YMap | null, key: string): { value: YValue; line: number } | null {
  const entry = map?.entries.find((candidate) => candidate.key === key);
  return entry ? { value: entry.value, line: entry.line } : null;
}

// Every scalar below a value, with its line.
export function scalars(value: YValue): YScalar[] {
  if (!value) return [];
  if (value.type === "scalar") return [value];
  if (value.type === "seq") return value.items.flatMap((item) => scalars(item.value));
  return value.entries.flatMap((entry) => scalars(entry.value));
}

type Anchors = Map<string, YValue>;

function convert(node: SyntaxNode, anchors: Anchors): YValue {
  switch (node.type) {
    case "block_node":
    case "flow_node": {
      let value: YValue = null;
      let anchor: string | null = null;
      for (const child of node.namedChildren) {
        if (child.type === "anchor") anchor = child.namedChildren.find((inner) => inner.type === "anchor_name")?.text ?? null;
        else if (child.type !== "tag" && child.type !== "comment") value = convert(child, anchors);
      }
      if (anchor) anchors.set(anchor, value);
      return value;
    }
    case "alias":
      return anchors.get(node.namedChildren.find((child) => child.type === "alias_name")?.text ?? "") ?? null;
    case "plain_scalar":
      return { type: "scalar", text: node.text.trim(), line: node.startPosition.row + 1 };
    case "double_quote_scalar":
      return { type: "scalar", text: unescapeDouble(node.text.slice(1, -1)), line: node.startPosition.row + 1 };
    case "single_quote_scalar":
      return { type: "scalar", text: node.text.slice(1, -1).replace(/''/gu, "'"), line: node.startPosition.row + 1 };
    case "block_scalar":
      return blockScalar(node);
    case "block_mapping":
    case "flow_mapping":
      return mapping(node, anchors);
    case "block_sequence":
    case "flow_sequence":
      return sequence(node, anchors);
    default:
      return null;
  }
}

function mapping(node: SyntaxNode, anchors: Anchors): YMap {
  const map: YMap = { type: "map", entries: [] };
  for (const pair of node.namedChildren) {
    if (pair.type !== "block_mapping_pair" && pair.type !== "flow_pair") continue;
    const [keyNode, valueNode] = pair.namedChildren.filter((child) => child.type !== "comment");
    const keyValue = keyNode ? convert(keyNode, anchors) : null;
    const key = asText(keyValue);
    if (key === null) continue;
    const value = valueNode ? convert(valueNode, anchors) : null;
    if (key === "<<" && value?.type === "map") {
      // `<<: *base` adds the keys the mapping does not set itself (those after it win).
      map.entries.push(...value.entries.filter((entry) => !map.entries.some((existing) => existing.key === entry.key)).map((entry) => ({ ...entry })));
      continue;
    }
    const existing = map.entries.findIndex((entry) => entry.key === key);
    const entry = { key, line: pair.startPosition.row + 1, value };
    if (existing === -1) map.entries.push(entry);
    else map.entries[existing] = entry;
  }
  return map;
}

function sequence(node: SyntaxNode, anchors: Anchors): YSeq {
  const items: YSeq["items"] = [];
  for (const child of node.namedChildren) {
    if (child.type === "comment") continue;
    // A block sequence holds `block_sequence_item`s; a flow sequence holds the values (or `flow_pair`s).
    const inner = child.type === "block_sequence_item" ? child.namedChildren.find((candidate) => candidate.type !== "comment") : child;
    if (!inner) {
      items.push({ value: null, line: child.startPosition.row + 1 });
      continue;
    }
    items.push({ value: inner.type === "flow_pair" ? mapping({ namedChildren: [inner] } as unknown as SyntaxNode, anchors) : convert(inner, anchors), line: child.startPosition.row + 1 });
  }
  return { type: "seq", items };
}

// `|` and `>` blocks: the lines below the header, indentation removed. `line`
// is the header's line, so line `n` of the text is at `line + n`.
function blockScalar(node: SyntaxNode): YScalar {
  const lines = node.text.split(/\r?\n/u);
  lines.shift();
  const body = lines.filter((line) => line.trim() !== "");
  const indent = body.length === 0 ? 0 : Math.min(...body.map((line) => /^ */u.exec(line)![0].length));
  const text = lines.map((line) => line.slice(Math.min(indent, /^ */u.exec(line)![0].length))).join("\n").replace(/\n+$/u, "");
  return { type: "scalar", text, line: node.startPosition.row + 1 };
}

function unescapeDouble(text: string): string {
  return text.replace(/\\(["\\/nt])/gu, (_match, char: string) => (char === "n" ? "\n" : char === "t" ? "\t" : char));
}
