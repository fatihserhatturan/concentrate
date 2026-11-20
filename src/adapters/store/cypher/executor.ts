import type { QueryParameters } from "../../../core/contracts/query-engine.js";
import { NodeRecord, RelationshipRecord, type MemoryGraph, type PropertyValue } from "../graph.js";
import type { Expression, MatchClause, NodePattern, ProjectionClause, RelationshipPattern } from "./ast.js";
import { bindQuery, columnName, containsAggregate, type BoundQuery } from "./binder.js";
import { CypherError } from "./errors.js";
import { AGGREGATE_FUNCTIONS, SCALAR_FUNCTIONS, type Accumulator } from "./functions.js";
import { parseCypher } from "./parser.js";
import { planMatch, type ExpandStep, type MatchPlan, type NodeTarget, type PartPlan, type StartLookup } from "./planner.js";
import { compareComparable, compareForSort, equals, toOutput, valueKey, type Value } from "./values.js";

export type { QueryParameters };

type Row = Readonly<Record<string, Value>>;

type Context = {
  graph: MemoryGraph;
  bound: BoundQuery;
  params: QueryParameters;
  /** Results of aggregate calls while projecting a group. */
  aggregates?: ReadonlyMap<Expression, Value>;
};

/** Parse, bind and run a read-only query against `graph`. */
export function executeCypher(graph: MemoryGraph, source: string, params: QueryParameters = {}): Record<string, unknown>[] {
  const query = parseCypher(source);
  const bound = bindQuery(query, params, graph.schema);
  const context: Context = { graph, bound, params };

  let rows: Iterable<Row> = [{}];
  query.clauses.forEach((clause, index) => {
    rows = clause.kind === "match"
      ? runMatch(clause, rows, context, index)
      : runProjection(clause, [...rows], context);
  });

  return [...rows].map((row) => {
    const output: Record<string, unknown> = {};
    for (const column of bound.columns) output[column] = toOutput(row[column] ?? null, graph.schema);
    return output;
  });
}

function* runMatch(clause: MatchClause, rows: Iterable<Row>, context: Context, index: number): Generator<Row> {
  const { bound, graph } = context;
  const nameOf = (element: NodePattern | RelationshipPattern) => element.variable ?? bound.anonymous.get(element)!;
  const estimate = (lookup: StartLookup, labels: readonly string[]) => {
    const value = evaluate(lookup.value, {}, context);
    if (!isPropertyValue(value)) return undefined;
    let total = 0;
    for (const label of labels) {
      const found = graph.lookup(label, lookup.property, value);
      if (!found) return undefined;
      total += found.size;
    }
    return total;
  };
  const plan = planMatch(clause, bound.scopes[index]!, bound.scopes[index + 1]!, nameOf, graph, estimate);

  for (const row of rows) {
    let matched = false;
    for (const result of matchClause(plan, row, context)) {
      matched = true;
      yield result;
    }
    if (clause.optional && !matched) {
      const filled: Record<string, Value> = { ...row };
      for (const name of plan.introduced) filled[name] = null;
      yield filled;
    }
  }
}

function* matchClause(plan: MatchPlan, row: Row, context: Context): Generator<Row> {
  if (!passes(plan.filters, row, context)) return;
  yield* matchParts(plan.parts, 0, row, context);
}

function* matchParts(parts: readonly PartPlan[], index: number, row: Row, context: Context): Generator<Row> {
  if (index === parts.length) {
    yield row;
    return;
  }
  for (const next of matchPart(parts[index]!, row, context)) yield* matchParts(parts, index + 1, next, context);
}

function* matchPart(part: PartPlan, row: Row, context: Context): Generator<Row> {
  for (const node of startCandidates(part, row, context)) {
    if (!nodeMatches(part.start, node, row, context)) continue;
    const next = part.start.bound ? row : { ...row, [part.start.name]: node };
    if (!passes(part.startFilters, next, context)) continue;
    yield* expand(part.steps, 0, next, context);
  }
}

function startCandidates(part: PartPlan, row: Row, context: Context): Iterable<NodeRecord> {
  const { start, lookup } = part;
  if (start.bound) {
    const value = row[start.name];
    return value instanceof NodeRecord ? [value] : [];
  }
  if (lookup) {
    const value = evaluate(lookup.value, row, context);
    if (!isPropertyValue(value) || value === null) return [];
    return [...start.labels].flatMap((label) => [...(context.graph.lookup(label, lookup.property, value) ?? [])]);
  }
  return [...start.labels].flatMap((label) => [...context.graph.nodesWithLabel(label)]);
}

function* expand(steps: readonly ExpandStep[], index: number, row: Row, context: Context): Generator<Row> {
  if (index === steps.length) {
    yield row;
    return;
  }
  const step = steps[index]!;
  const from = row[step.source];
  if (!(from instanceof NodeRecord)) return;
  for (const [relationship, node] of traverse(step, from, row, context)) {
    if (!nodeMatches(step.target, node, row, context)) continue;
    const next: Record<string, Value> = { ...row, [step.relationshipName]: relationship };
    if (!step.target.bound) next[step.target.name] = node;
    if (!passes(step.filters, next, context)) continue;
    yield* expand(steps, index + 1, next, context);
  }
}

function* traverse(step: ExpandStep, from: NodeRecord, row: Row, context: Context): Generator<[Value, NodeRecord]> {
  const { relationship } = step;
  const direction = step.reversed ? flip(relationship.direction) : relationship.direction;
  const types = relationship.types.length > 0 ? new Set(relationship.types) : undefined;
  const properties = relationship.properties.map(([name, expression]) => [name, evaluate(expression, row, context)] as const);
  const accepts = (candidate: RelationshipRecord) => (!types || types.has(candidate.type))
    && properties.every(([name, value]) => equals(candidate.property(name), value) === true);

  const neighbours = function* (node: NodeRecord): Generator<[RelationshipRecord, NodeRecord]> {
    if (direction !== "in") {
      for (const candidate of node.outgoing) if (accepts(candidate)) yield [candidate, candidate.to];
    }
    if (direction !== "out") {
      for (const candidate of node.incoming) if (accepts(candidate)) yield [candidate, candidate.from];
    }
  };

  if (!relationship.hops) {
    yield* neighbours(from);
    return;
  }

  // Walk semantics, like Kuzu: relationships and nodes may repeat along a path.
  const { min, max } = relationship.hops;
  const path: RelationshipRecord[] = [];
  const walk = function* (node: NodeRecord): Generator<[Value, NodeRecord]> {
    if (path.length >= min) yield [step.reversed ? [...path].reverse() : [...path], node];
    if (path.length === max) return;
    for (const [candidate, next] of neighbours(node)) {
      path.push(candidate);
      yield* walk(next);
      path.pop();
    }
  };
  yield* walk(from);
}

function flip(direction: RelationshipPattern["direction"]): RelationshipPattern["direction"] {
  return direction === "out" ? "in" : direction === "in" ? "out" : "both";
}

function nodeMatches(target: NodeTarget, node: NodeRecord, row: Row, context: Context): boolean {
  if (target.bound) {
    if (row[target.name] !== node) return false;
  }
  if (!target.labels.has(node.label)) return false;
  return target.pattern.properties.every(([name, expression]) => equals(node.property(name), evaluate(expression, row, context)) === true);
}

function passes(filters: readonly Expression[], row: Row, context: Context): boolean {
  return filters.every((filter) => evaluate(filter, row, context) === true);
}

function runProjection(clause: ProjectionClause, rows: Row[], context: Context): Row[] {
  const aggregating = clause.items.some((item) => containsAggregate(item.expression));
  let projected: Array<{ row: Row; sortRow: Row }>;

  if (aggregating) {
    projected = aggregate(clause, rows, context);
  } else {
    projected = rows.map((row) => {
      const next: Record<string, Value> = {};
      for (const item of clause.items) next[columnName(item)] = evaluate(item.expression, row, context);
      return { row: next, sortRow: clause.distinct ? next : { ...next, ...row } };
    });
  }

  if (clause.distinct) {
    const seen = new Set<string>();
    projected = projected.filter(({ row }) => {
      const key = clause.items.map((item) => valueKey(row[columnName(item)] ?? null)).join("\u0000");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  if (clause.orderBy.length > 0) {
    const keyed = projected.map((entry, position) => ({
      entry,
      position,
      keys: clause.orderBy.map((item) => evaluate(item.expression, entry.sortRow, { ...context, aggregates: aggregatesOf(entry) })),
    }));
    keyed.sort((left, right) => {
      for (let i = 0; i < clause.orderBy.length; i += 1) {
        const comparison = compareForSort(left.keys[i]!, right.keys[i]!);
        if (comparison !== 0) return clause.orderBy[i]!.descending ? -comparison : comparison;
      }
      return left.position - right.position;
    });
    projected = keyed.map(({ entry }) => entry);
  }

  const skip = clause.skip ? count(clause.skip, "SKIP", context) : 0;
  const limit = clause.limit ? count(clause.limit, "LIMIT", context) : Number.POSITIVE_INFINITY;
  let result = projected.slice(skip, skip + limit).map(({ row }) => row);
  if (clause.where) result = result.filter((row) => evaluate(clause.where!, row, context) === true);
  return result;
}

const groupAggregates = new WeakMap<object, ReadonlyMap<Expression, Value>>();

function aggregatesOf(entry: { row: Row }): ReadonlyMap<Expression, Value> | undefined {
  return groupAggregates.get(entry);
}

function aggregate(clause: ProjectionClause, rows: Row[], context: Context): Array<{ row: Row; sortRow: Row }> {
  const calls: Expression[] = [];
  const collect = (expression: Expression) => walk(expression, (node) => {
    if (node.kind === "call" && node.name.toLowerCase() in AGGREGATE_FUNCTIONS) {
      calls.push(node);
      return false;
    }
    return true;
  });
  const keyItems = clause.items.filter((item) => !containsAggregate(item.expression));
  for (const item of clause.items) if (containsAggregate(item.expression)) collect(item.expression);
  for (const item of clause.orderBy) collect(item.expression);

  type Group = { row: Row; keys: Value[]; accumulators: Accumulator[] };
  const groups = new Map<string, Group>();
  const createAccumulators = () => calls.map((call) => {
    const expression = call as Extract<Expression, { kind: "call" }>;
    return AGGREGATE_FUNCTIONS[expression.name.toLowerCase()]!.create(expression.distinct);
  });

  for (const row of rows) {
    const keys = keyItems.map((item) => evaluate(item.expression, row, context));
    const key = keys.map(valueKey).join("\u0000");
    let group = groups.get(key);
    if (!group) groups.set(key, group = { row, keys, accumulators: createAccumulators() });
    calls.forEach((call, index) => {
      const expression = call as Extract<Expression, { kind: "call" }>;
      group!.accumulators[index]!.add(expression.star ? true : evaluate(expression.args[0]!, row, context));
    });
  }
  if (groups.size === 0 && keyItems.length === 0) {
    groups.set("", { row: {}, keys: [], accumulators: createAccumulators() });
  }

  return [...groups.values()].map((group) => {
    const results = new Map(calls.map((call, index) => [call, group.accumulators[index]!.result()]));
    const groupContext = { ...context, aggregates: results };
    const next: Record<string, Value> = {};
    let keyIndex = 0;
    for (const item of clause.items) {
      next[columnName(item)] = containsAggregate(item.expression)
        ? evaluate(item.expression, group.row, groupContext)
        : group.keys[keyIndex++]!;
    }
    const entry = { row: next, sortRow: next };
    groupAggregates.set(entry, results);
    return entry;
  });
}

function walk(expression: Expression, visit: (expression: Expression) => boolean): void {
  if (!visit(expression)) return;
  switch (expression.kind) {
    case "property":
      walk(expression.object, visit);
      break;
    case "list":
      expression.items.forEach((item) => walk(item, visit));
      break;
    case "unary":
    case "isNull":
      walk(expression.operand, visit);
      break;
    case "binary":
      walk(expression.left, visit);
      walk(expression.right, visit);
      break;
    case "call":
      expression.args.forEach((argument) => walk(argument, visit));
      break;
    case "case":
      if (expression.subject) walk(expression.subject, visit);
      for (const [condition, result] of expression.branches) {
        walk(condition, visit);
        walk(result, visit);
      }
      if (expression.otherwise) walk(expression.otherwise, visit);
      break;
    default:
      break;
  }
}

function count(expression: Expression, clause: string, context: Context): number {
  const value = evaluate(expression, {}, context);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new CypherError("runtime", `${clause} expects a non-negative integer, got ${JSON.stringify(toOutput(value, context.graph.schema))}`);
  }
  return value;
}

function evaluate(expression: Expression, row: Row, context: Context): Value {
  switch (expression.kind) {
    case "literal":
      return expression.value;
    case "parameter":
      return toValue(context.params[expression.name]);
    case "variable":
      return row[expression.name] ?? null;
    case "property": {
      const object = evaluate(expression.object, row, context);
      if (object instanceof NodeRecord || object instanceof RelationshipRecord) return object.property(expression.name);
      return null;
    }
    case "list":
      return expression.items.map((item) => evaluate(item, row, context));
    case "unary": {
      const operand = evaluate(expression.operand, row, context);
      if (expression.operator === "NOT") return operand === null ? null : !truth(operand);
      if (operand === null) return null;
      const number = numeric(operand, expression.operator);
      return expression.operator === "-" ? -number : number;
    }
    case "isNull": {
      const isNull = evaluate(expression.operand, row, context) === null;
      return expression.negated ? !isNull : isNull;
    }
    case "binary":
      return evaluateBinary(expression, row, context);
    case "case": {
      const subject = expression.subject ? evaluate(expression.subject, row, context) : undefined;
      for (const [condition, result] of expression.branches) {
        const value = evaluate(condition, row, context);
        const hit = subject === undefined ? value === true : equals(subject, value) === true;
        if (hit) return evaluate(result, row, context);
      }
      return expression.otherwise ? evaluate(expression.otherwise, row, context) : null;
    }
    case "call": {
      const name = expression.name.toLowerCase();
      if (name in AGGREGATE_FUNCTIONS) {
        const result = context.aggregates?.get(expression);
        if (result === undefined) throw new CypherError("runtime", `aggregate ${expression.name}() used outside a projection`);
        return result;
      }
      return SCALAR_FUNCTIONS[name]!.call(expression.args.map((argument) => evaluate(argument, row, context)));
    }
  }
}

function evaluateBinary(expression: Extract<Expression, { kind: "binary" }>, row: Row, context: Context): Value {
  const { operator } = expression;
  const left = evaluate(expression.left, row, context);

  // Three-valued logic; AND / OR short-circuit only on a deciding value.
  if (operator === "AND" || operator === "OR" || operator === "XOR") {
    const a = left === null ? null : truth(left);
    if (operator === "AND" && a === false) return false;
    if (operator === "OR" && a === true) return true;
    const rightValue = evaluate(expression.right, row, context);
    const b = rightValue === null ? null : truth(rightValue);
    if (operator === "AND") return b === false ? false : a === null || b === null ? null : true;
    if (operator === "OR") return b === true ? true : a === null || b === null ? null : false;
    return a === null || b === null ? null : a !== b;
  }

  const right = evaluate(expression.right, row, context);
  switch (operator) {
    case "=":
      return equals(left, right);
    case "<>": {
      const result = equals(left, right);
      return result === null ? null : !result;
    }
    case "<":
    case ">":
    case "<=":
    case ">=": {
      const comparison = compareComparable(left, right);
      if (comparison === null) return null;
      return operator === "<" ? comparison < 0 : operator === ">" ? comparison > 0 : operator === "<=" ? comparison <= 0 : comparison >= 0;
    }
    case "IN": {
      if (right === null) return null;
      if (!Array.isArray(right)) throw new CypherError("runtime", "IN expects a list on the right-hand side");
      let unknown = false;
      for (const item of right) {
        const result = equals(left, item);
        if (result === true) return true;
        if (result === null) unknown = true;
      }
      return unknown ? null : false;
    }
    case "STARTS WITH":
    case "ENDS WITH":
    case "CONTAINS": {
      if (left === null || right === null) return null;
      if (typeof left !== "string" || typeof right !== "string") throw new CypherError("runtime", `${operator} expects strings`);
      return operator === "STARTS WITH" ? left.startsWith(right) : operator === "ENDS WITH" ? left.endsWith(right) : left.includes(right);
    }
    case "+":
      // Like Kuzu, string concatenation treats null as the empty string.
      if (typeof left === "string" || typeof right === "string" || stringTyped(expression, context)) {
        if (Array.isArray(left) || Array.isArray(right)) throw new CypherError("runtime", "cannot add a string and a list");
        return `${left === null ? "" : String(toOutput(left, context.graph.schema))}${right === null ? "" : String(toOutput(right, context.graph.schema))}`;
      }
      if (left === null || right === null) return null;
      if (Array.isArray(left) || Array.isArray(right)) {
        return [...(Array.isArray(left) ? left : [left]), ...(Array.isArray(right) ? right : [right])];
      }
      return numeric(left, operator) + numeric(right, operator);
    case "-":
      if (left === null || right === null) return null;
      return numeric(left, operator) - numeric(right, operator);
    case "*":
      if (left === null || right === null) return null;
      return numeric(left, operator) * numeric(right, operator);
    case "/":
    case "%": {
      if (left === null || right === null) return null;
      const a = numeric(left, operator);
      const b = numeric(right, operator);
      if (!integerOperands(expression, a, b, context)) return operator === "/" ? a / b : a % b;
      if (b === 0) throw new CypherError("runtime", "Divide by zero.");
      return operator === "/" ? Math.trunc(a / b) : a % b;
    }
  }
}

function stringTyped(expression: Extract<Expression, { kind: "binary" }>, context: Context): boolean {
  return context.bound.types.get(expression.left) === "STRING" || context.bound.types.get(expression.right) === "STRING";
}

/** Integer division needs both sides typed INT; values of unknown static type count as integers when they are whole. */
function integerOperands(expression: Extract<Expression, { kind: "binary" }>, a: number, b: number, context: Context): boolean {
  const leftType = context.bound.types.get(expression.left);
  const rightType = context.bound.types.get(expression.right);
  if (leftType === "FLOAT" || rightType === "FLOAT") return false;
  return Number.isInteger(a) && Number.isInteger(b);
}

function truth(value: Value): boolean {
  if (typeof value !== "boolean") throw new CypherError("runtime", `expected a boolean, got ${JSON.stringify(toOutput(value))}`);
  return value;
}

function numeric(value: Value, operator: string): number {
  if (typeof value !== "number") throw new CypherError("runtime", `${operator} expects numbers, got ${JSON.stringify(toOutput(value))}`);
  return value;
}

function isPropertyValue(value: Value): value is PropertyValue {
  return value === null || typeof value !== "object";
}

function toValue(value: unknown): Value {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(toValue);
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return Number(value);
  throw new CypherError("runtime", `unsupported parameter value ${String(value)}`);
}
