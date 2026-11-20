import type { GraphSchemaIndex } from "../../../core/graph/schema.js";
import type { Clause, Expression, MatchClause, NodePattern, ProjectionClause, Query, RelationshipPattern } from "./ast.js";
import { CypherError } from "./errors.js";
import { AGGREGATE_FUNCTIONS, SCALAR_FUNCTIONS } from "./functions.js";

/**
 * Name resolution and validation. Variables get a kind and, for nodes and
 * relationships, the labels / types they can have: explicit ones, or those
 * implied by adjacent relationship tables (`(x)-[:CALLS]->()` makes x a
 * Function). Property access is checked against those tables, like Kuzu's
 * binder. Expressions get a static type, used for integer division.
 */

export type StaticType = "INT" | "FLOAT" | "STRING" | "BOOL" | "LIST" | "NODE" | "REL" | "NULL" | "ANY";

export type VariableInfo =
  /** `labeled`: some pattern gave the node a label; otherwise its labels were inferred from relationships. */
  | { kind: "node"; labels: readonly string[]; labeled: boolean }
  | { kind: "rel"; types: readonly string[]; list: boolean }
  | { kind: "value"; type: StaticType };

export type Scope = Map<string, VariableInfo>;

export type BoundQuery = {
  query: Query;
  /** The tables names and properties were resolved against. */
  schema: GraphSchemaIndex;
  /** Scope visible at the start of each clause. */
  scopes: Scope[];
  types: WeakMap<Expression, StaticType>;
  /** Internal names given to anonymous pattern elements. */
  anonymous: WeakMap<NodePattern | RelationshipPattern, string>;
  columns: string[];
};

export function bindQuery(query: Query, params: Readonly<Record<string, unknown>>, schema: GraphSchemaIndex): BoundQuery {
  const bound: BoundQuery = { query, schema, scopes: [], types: new WeakMap(), anonymous: new WeakMap(), columns: [] };
  let scope: Scope = new Map();
  let anonymousCount = 0;

  for (const clause of query.clauses) {
    bound.scopes.push(new Map(scope));
    if (clause.kind === "match") {
      scope = bindMatch(clause, scope, bound, params, () => `  anon${anonymousCount++}`);
    } else {
      scope = bindProjection(clause, scope, bound, params);
    }
  }
  const last = query.clauses.at(-1) as ProjectionClause;
  bound.columns = last.items.map(columnName);
  return bound;
}

export function columnName(item: { alias?: string; text: string }): string {
  return item.alias ?? item.text;
}

function bindMatch(
  clause: MatchClause,
  outer: Scope,
  bound: BoundQuery,
  params: Readonly<Record<string, unknown>>,
  anonymousName: () => string,
): Scope {
  const scope: Scope = new Map(outer);

  // Pass 1: declare variables with explicit labels and types.
  for (const part of clause.patterns) {
    for (const node of part.nodes) declareNode(node, scope, bound, anonymousName);
    for (const relationship of part.relationships) declareRelationship(relationship, scope, bound, anonymousName);
  }

  // Pass 2: narrow unlabeled endpoints using the relationship tables next to them.
  for (const part of clause.patterns) {
    part.relationships.forEach((relationship, index) => {
      if (relationship.hops) return;
      const types = relationship.types.length > 0 ? relationship.types : bound.schema.relationshipTypes;
      const left = part.nodes[index]!;
      const right = part.nodes[index + 1]!;
      const froms = new Set(types.map((type) => bound.schema.relationshipTableByType.get(type)!.from));
      const tos = new Set(types.map((type) => bound.schema.relationshipTableByType.get(type)!.to));
      const both = new Set([...froms, ...tos]);
      const leftAllowed = relationship.direction === "out" ? froms : relationship.direction === "in" ? tos : both;
      const rightAllowed = relationship.direction === "out" ? tos : relationship.direction === "in" ? froms : both;
      narrow(scope, nameOf(left, bound), leftAllowed);
      narrow(scope, nameOf(right, bound), rightAllowed);
    });
  }

  for (const part of clause.patterns) {
    for (const node of part.nodes) {
      for (const [name, expression] of node.properties) {
        checkProperty(scope.get(nameOf(node, bound))!, name, nameOf(node, bound), bound.schema);
        bindExpression(expression, scope, bound, params, "pattern");
      }
    }
    for (const relationship of part.relationships) {
      for (const [name, expression] of relationship.properties) {
        checkProperty(scope.get(nameOf(relationship, bound))!, name, nameOf(relationship, bound), bound.schema);
        bindExpression(expression, scope, bound, params, "pattern");
      }
    }
  }

  if (clause.where) bindExpression(clause.where, scope, bound, params, "where");
  return scope;
}

function nameOf(element: NodePattern | RelationshipPattern, bound: BoundQuery): string {
  return element.variable ?? bound.anonymous.get(element)!;
}

function declareNode(node: NodePattern, scope: Scope, bound: BoundQuery, anonymousName: () => string): void {
  for (const label of node.labels) {
    if (!bound.schema.nodeTableByLabel.has(label)) throw new CypherError("binder", `Table ${label} does not exist.`);
  }
  if (!node.variable) bound.anonymous.set(node, anonymousName());
  const name = nameOf(node, bound);
  const existing = scope.get(name);
  const labels = node.labels.length > 0 ? node.labels : bound.schema.nodeLabels;
  if (!existing) {
    scope.set(name, { kind: "node", labels: [...labels], labeled: node.labels.length > 0 });
    return;
  }
  if (existing.kind !== "node") {
    throw new CypherError("binder", `${name} is not a node variable.`);
  }
  if (node.labels.length > 0) {
    scope.set(name, { kind: "node", labels: existing.labels.filter((label) => node.labels.includes(label)), labeled: true });
  }
}

function declareRelationship(
  relationship: RelationshipPattern,
  scope: Scope,
  bound: BoundQuery,
  anonymousName: () => string,
): void {
  for (const type of relationship.types) {
    if (!bound.schema.relationshipTableByType.has(type)) throw new CypherError("binder", `Table ${type} does not exist.`);
  }
  if (!relationship.variable) {
    bound.anonymous.set(relationship, anonymousName());
    return;
  }
  if (scope.has(relationship.variable)) {
    throw new CypherError("binder", `Relationship variable ${relationship.variable} is already bound; matching a bound relationship is not supported.`);
  }
  scope.set(relationship.variable, {
    kind: "rel",
    types: relationship.types.length > 0 ? [...relationship.types] : bound.schema.relationshipTypes,
    list: relationship.hops !== undefined,
  });
}

function narrow(scope: Scope, name: string, allowed: ReadonlySet<string>): void {
  const info = scope.get(name);
  if (info?.kind !== "node") return;
  const narrowed = info.labels.filter((label) => allowed.has(label));
  scope.set(name, { ...info, labels: narrowed });
}

function bindProjection(
  clause: ProjectionClause,
  scope: Scope,
  bound: BoundQuery,
  params: Readonly<Record<string, unknown>>,
): Scope {
  const next: Scope = new Map();
  const names = new Set<string>();
  for (const item of clause.items) {
    const type = bindExpression(item.expression, scope, bound, params, "projection");
    if (clause.kind === "with" && !item.alias && item.expression.kind !== "variable") {
      throw new CypherError("binder", `Expression ${item.text} in WITH must be aliased (use AS).`);
    }
    const name = columnName(item);
    if (names.has(name)) throw new CypherError("binder", `Multiple result columns with the same name ${name} are not supported.`);
    names.add(name);
    const info: VariableInfo = item.expression.kind === "variable"
      ? scope.get(item.expression.name)!
      : { kind: "value", type };
    next.set(name, info);
  }

  // ORDER BY sees the projected names, plus the incoming variables unless the projection aggregates or is
  // DISTINCT. Like Kuzu, an incoming variable wins over an alias of the same name (`f.path AS f ORDER BY f.path`).
  const aggregating = clause.items.some((item) => containsAggregate(item.expression));
  const orderScope: Scope = aggregating || clause.distinct ? new Map(next) : new Map([...next, ...scope]);
  for (const item of clause.orderBy) bindExpression(item.expression, orderScope, bound, params, "projection");
  if (clause.kind === "with" && clause.orderBy.length > 0 && !clause.skip && !clause.limit) {
    throw new CypherError("binder", "In WITH clause, ORDER BY must be followed by SKIP or LIMIT.");
  }
  for (const expression of [clause.skip, clause.limit]) {
    if (expression) bindExpression(expression, new Map(), bound, params, "where");
  }
  if (clause.where) bindExpression(clause.where, next, bound, params, "where");
  return next;
}

type Context = "pattern" | "where" | "projection";

function bindExpression(
  expression: Expression,
  scope: Scope,
  bound: BoundQuery,
  params: Readonly<Record<string, unknown>>,
  context: Context,
  insideAggregate = false,
): StaticType {
  const type = inferType(expression, scope, bound, params, context, insideAggregate);
  bound.types.set(expression, type);
  return type;
}

function inferType(
  expression: Expression,
  scope: Scope,
  bound: BoundQuery,
  params: Readonly<Record<string, unknown>>,
  context: Context,
  insideAggregate: boolean,
): StaticType {
  const recurse = (inner: Expression, nested = insideAggregate) => bindExpression(inner, scope, bound, params, context, nested);

  switch (expression.kind) {
    case "literal":
      return typeOfValue(expression.value, expression.float);
    case "parameter":
      if (!Object.hasOwn(params, expression.name)) {
        throw new CypherError("binder", `Parameter $${expression.name} is not provided.`);
      }
      return typeOfValue(params[expression.name]);
    case "variable": {
      const info = scope.get(expression.name);
      if (!info) throw new CypherError("binder", `Variable ${expression.name} is not in scope.`);
      if (info.kind === "node") return "NODE";
      if (info.kind === "rel") return info.list ? "LIST" : "REL";
      return info.type;
    }
    case "property": {
      recurse(expression.object);
      if (expression.object.kind === "variable") {
        const info = scope.get(expression.object.name)!;
        return checkProperty(info, expression.name, expression.object.name, bound.schema);
      }
      return "ANY";
    }
    case "list":
      expression.items.forEach((item) => recurse(item));
      return "LIST";
    case "unary": {
      const operand = recurse(expression.operand);
      return expression.operator === "NOT" ? "BOOL" : operand;
    }
    case "binary": {
      const left = recurse(expression.left);
      const right = recurse(expression.right);
      switch (expression.operator) {
        case "+":
          if (left === "STRING" || right === "STRING") {
            const other = left === "STRING" ? right : left;
            if (other !== "STRING" && other !== "NULL" && other !== "ANY") {
              throw new CypherError("binder", `Cannot add STRING and ${other}.`);
            }
            return "STRING";
          }
          if (left === "LIST" || right === "LIST") return "LIST";
          return numericType(left, right);
        case "-":
        case "*":
        case "%":
        case "/":
          return numericType(left, right);
        default:
          return "BOOL";
      }
    }
    case "isNull":
      recurse(expression.operand);
      return "BOOL";
    case "case": {
      if (expression.subject) recurse(expression.subject);
      const results = new Set<StaticType>();
      for (const [condition, result] of expression.branches) {
        recurse(condition);
        results.add(recurse(result));
      }
      if (expression.otherwise) results.add(recurse(expression.otherwise));
      results.delete("NULL");
      return results.size === 1 ? [...results][0]! : "ANY";
    }
    case "call": {
      const name = expression.name.toLowerCase();
      const aggregate = AGGREGATE_FUNCTIONS[name];
      if (aggregate) {
        if (context !== "projection") {
          throw new CypherError("binder", `Aggregate function ${expression.name}() is not allowed in ${context === "where" ? "WHERE" : "a pattern"}.`);
        }
        if (insideAggregate) throw new CypherError("binder", "Aggregate functions cannot be nested.");
        if (expression.star && name !== "count") throw new CypherError("binder", `${expression.name}(*) is not supported.`);
        if (!expression.star && expression.args.length !== 1) {
          throw new CypherError("binder", `${expression.name}() takes exactly one argument.`);
        }
        const argument = expression.star ? "ANY" : recurse(expression.args[0]!, true);
        return aggregate.resultType(argument);
      }
      const scalar = SCALAR_FUNCTIONS[name];
      if (!scalar) throw new CypherError("binder", `Function ${expression.name} is not supported.`);
      if (expression.distinct || expression.star) throw new CypherError("binder", `${expression.name}() does not take DISTINCT or *.`);
      if (expression.args.length < scalar.minArgs || expression.args.length > scalar.maxArgs) {
        throw new CypherError("binder", `Function ${expression.name} does not take ${expression.args.length} arguments.`);
      }
      const argumentTypes = expression.args.map((argument) => recurse(argument));
      return scalar.resultType(argumentTypes);
    }
  }
}

function checkProperty(info: VariableInfo, property: string, variable: string, schema: GraphSchemaIndex): StaticType {
  if (info.kind === "value") {
    if (info.type === "ANY" || info.type === "NULL") return "ANY";
    throw new CypherError("binder", `${variable} has type ${info.type} and has no property ${property}.`);
  }
  const tables = info.kind === "node"
    ? info.labels.map((label) => schema.nodeTableByLabel.get(label)!.properties)
    : info.types.map((type) => schema.relationshipTableByType.get(type)!.properties);
  if (info.kind === "node" && property === "id") return "STRING";
  // Endpoint labels no relationship table allows: Kuzu returns no rows rather than an error.
  if (tables.length === 0) return "ANY";
  const types = new Set(tables.map((properties) => properties[property]).filter((type) => type !== undefined));
  if (types.size === 0) {
    // Kuzu checks an unlabeled node against every node table, not just the ones its relationships allow.
    if (info.kind === "node" && !info.labeled && schema.nodeTables.some((table) => property in table.properties)) return "ANY";
    throw new CypherError("binder", `Cannot find property ${property} for ${variable}.`);
  }
  if (types.size > 1) return "ANY";
  return ({ STRING: "STRING", INT64: "INT", BOOLEAN: "BOOL" } as const)[[...types][0]!];
}

export function containsAggregate(expression: Expression): boolean {
  switch (expression.kind) {
    case "call":
      return expression.name.toLowerCase() in AGGREGATE_FUNCTIONS || expression.args.some(containsAggregate);
    case "property":
      return containsAggregate(expression.object);
    case "list":
      return expression.items.some(containsAggregate);
    case "unary":
      return containsAggregate(expression.operand);
    case "binary":
      return containsAggregate(expression.left) || containsAggregate(expression.right);
    case "isNull":
      return containsAggregate(expression.operand);
    case "case":
      return (expression.subject ? containsAggregate(expression.subject) : false)
        || expression.branches.some(([condition, result]) => containsAggregate(condition) || containsAggregate(result))
        || (expression.otherwise ? containsAggregate(expression.otherwise) : false);
    default:
      return false;
  }
}

function typeOfValue(value: unknown, float = false): StaticType {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return float || !Number.isInteger(value) ? "FLOAT" : "INT";
  if (typeof value === "string") return "STRING";
  if (typeof value === "boolean") return "BOOL";
  if (Array.isArray(value)) return "LIST";
  return "ANY";
}

function numericType(left: StaticType, right: StaticType): StaticType {
  if (left === "INT" && right === "INT") return "INT";
  if (left === "FLOAT" || right === "FLOAT") return "FLOAT";
  return "ANY";
}

export type { Clause };
