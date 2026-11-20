import { NodeRecord, RelationshipRecord } from "../graph.js";
import type { GraphSchemaIndex } from "../../../core/graph/schema.js";

/** Runtime values. Variable-length relationships are lists of RelationshipRecord. */
export type Value = null | number | string | boolean | NodeRecord | RelationshipRecord | Value[];

/** Cypher equality: null if either side is null or the types cannot be compared. */
export function equals(left: Value, right: Value): boolean | null {
  if (left === null || right === null) return null;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return null;
    if (left.length !== right.length) return false;
    let unknown = false;
    for (let i = 0; i < left.length; i += 1) {
      const result = equals(left[i]!, right[i]!);
      if (result === false) return false;
      if (result === null) unknown = true;
    }
    return unknown ? null : true;
  }
  if (typeof left !== typeof right) return null;
  if (typeof left === "object") {
    if (left.constructor !== (right as object).constructor) return null;
    return left === right;
  }
  return left === right;
}

/** `<`, `>` ...: a negative, zero or positive number, or null when the values cannot be ordered. */
export function compareComparable(left: Value, right: Value): number | null {
  if (left === null || right === null) return null;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "string" && typeof right === "string") return compareStrings(left, right);
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return null;
}

const typeRank = (value: Value): number => {
  if (typeof value === "boolean") return 0;
  if (typeof value === "number") return 1;
  if (typeof value === "string") return 2;
  if (value instanceof NodeRecord) return 3;
  if (value instanceof RelationshipRecord) return 4;
  if (Array.isArray(value)) return 5;
  return 6;
};

/** Total order for ORDER BY, min and max. Like Kuzu, null sorts after every other value. */
export function compareForSort(left: Value, right: Value): number {
  if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
  const rank = typeRank(left) - typeRank(right);
  if (rank !== 0) return rank;
  if (left instanceof NodeRecord) return compareStrings(left.id, (right as NodeRecord).id);
  if (left instanceof RelationshipRecord) {
    const other = right as RelationshipRecord;
    return compareStrings(left.from.id, other.from.id) || compareStrings(left.to.id, other.to.id) || compareStrings(left.type, other.type);
  }
  if (Array.isArray(left)) {
    const other = right as Value[];
    for (let i = 0; i < Math.min(left.length, other.length); i += 1) {
      const result = compareForSort(left[i]!, other[i]!);
      if (result !== 0) return result;
    }
    return left.length - other.length;
  }
  return compareComparable(left, right) ?? 0;
}

/** Byte order of the UTF-8 encoding, which is code point order. */
export function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  const a = [...left];
  const b = [...right];
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const difference = a[i]!.codePointAt(0)! - b[i]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

const relationshipKeys = new WeakMap<RelationshipRecord, number>();
let nextRelationshipKey = 0;

/** A string that is equal for equal values; used by DISTINCT and grouping. */
export function valueKey(value: Value): string {
  if (value === null) return "_";
  if (typeof value === "number") return `d${value}`;
  if (typeof value === "string") return `s${JSON.stringify(value)}`;
  if (typeof value === "boolean") return value ? "t" : "f";
  if (value instanceof NodeRecord) return `n${JSON.stringify(value.id)}`;
  if (value instanceof RelationshipRecord) {
    let key = relationshipKeys.get(value);
    if (key === undefined) relationshipKeys.set(value, key = nextRelationshipKey++);
    return `r${key}`;
  }
  return `[${value.map(valueKey).join(",")}]`;
}

/** Plain JSON-friendly output, shaped like the Kuzu Node.js driver's. */
export function toOutput(value: Value, schema?: GraphSchemaIndex): unknown {
  if (value instanceof NodeRecord) {
    const result: Record<string, unknown> = { _label: value.label, id: value.id };
    // Result columns follow the table's property order; error messages, which have no schema at hand, the node's own.
    for (const property of Object.keys(schema ? schema.nodeTableByLabel.get(value.label)!.properties : value.properties)) {
      if (property !== "id") result[property] = value.properties[property] ?? null;
    }
    return result;
  }
  if (value instanceof RelationshipRecord) {
    return { _label: value.type, _src: value.from.id, _dst: value.to.id, ...value.properties };
  }
  if (Array.isArray(value)) return value.map((item) => toOutput(item, schema));
  return value;
}
