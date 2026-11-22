import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import type { JavaParsePlugin } from "../../languages/java/parser.js";
import { compactExpression, modifiersOf, normalizeJavaType } from "../../languages/java/syntax.js";
import { createJavaTypeIndex, parseStringList, type JavaType } from "../../languages/java/types.js";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import { annotationEnum, annotationValue, findAnnotations, hasAnnotation, javaAnnotationReader, type JavaAnnotationInfo } from "./annotations.js";
import { javaDataModel, javaDataModelId, javaTable, javaTableModel, normalizeTableName, recordJavaDataAccesses, sqlAccesses, type JavaDataAccess, type JavaDataOperation } from "./data-shared.js";
import { createJavaReceiverResolver, receiverMatches } from "./receivers.js";
import { javaMethods } from "./shared.js";
import { createJavaStringResolver, javaLocalNames, javaStringFromText, readJavaString, readLocalStrings, type JavaStringScope, type JavaStringTemplate } from "./strings.js";

// Java JPA / Hibernate and Spring Data (`javax.persistence` and `jakarta.persistence`).
//
// Entities. A class with `@Entity` is a DataModel (library `jpa`, id `datamodel:jpa:<package>:<Class>`)
// with MAPS_TO_TABLE to its Table (`table:java:-:<name>`). The table is `@Table(name, schema)`, else the entity
// name (`@Entity(name = "X")`, else the class name), all in snake_case, Spring Boot's physical naming
// (`CatalogProduct` and `@Table(name = "OrderItems")` are `catalog_product` and `order_items`; the same for
// `@Column`, `@JoinColumn` and `@JoinTable` names); a quoted name (`@Table(name = "\"Items\"")`, backticks) is kept
// as written minus the quotes. A name given by a constant (`@Table(name = Tables.ITEMS)`) is resolved with the
// string resolver. The Table's `columns` (name, column, type, optional, list, isId, isUnique, references) come from
// the non-static, non-`transient`, non-`@Transient` fields of the class and of its `@MappedSuperclass`
// ancestors (their fields first); an `@Embedded` / `@EmbeddedId` field, or a field whose type is a scanned
// `@Embeddable`, adds the embeddable's fields (a column for each, no prefix); `@ManyToOne` / the owning side
// of `@OneToOne` adds the foreign key column (`@JoinColumn(name)`, else `<field>_<id column>`) with
// `references` = `<table>.<id column>`. The owning side of `@ManyToMany` makes the join table
// (`@JoinTable(name, schema, joinColumns, inverseJoinColumns)`, else `<table>_<target table>`) with its two
// foreign key columns, as a Table of its own without a DataModel.
// `@Inheritance` (on the topmost entity of a hierarchy): SINGLE_TABLE (the default) puts every entity of the
// hierarchy in the root's table (the subclasses' columns are added to it; a subclass keeps its own DataModel
// mapped to that table); JOINED gives each subclass a table of its own with its own fields only; TABLE_PER_CLASS
// a table of its own with the inherited fields too. No discriminator or primary key column is made.
// RELATES_TO between the entities' DataModels, with the properties Python's ORMs use: `field`, `kind` (`one`
// for `@ManyToOne` / `@OneToOne`, `many` for `@OneToMany` / `@ManyToMany`), `fields` (the foreign key columns of the
// owning side, `[]` on the `mappedBy` side), `references` (`[]`), `relationName` (null) and `onDelete`
// (Hibernate's `@OnDelete(action = CASCADE)`). The target is the field's type, or the type argument of a
// collection.
//
// Spring Data. An interface that (transitively, through scanned user interfaces with their type arguments,
// `BaseRepository<T, ID> extends JpaRepository<T, ID>`) extends `Repository`, `CrudRepository`, `ListCrudRepository`,
// `PagingAndSortingRepository`, `ListPagingAndSortingRepository` or `JpaRepository` (`org.springframework.data`)
// with a scanned JPA entity as first type argument is a repository: a DataModel (library `spring-data`,
// `datamodel:spring-data:<package>:<Interface>`) mapped to the entity's table, with RELATES_TO (`field`
// `entity`, kind `one`) to the entity's DataModel. Repositories of other stores (`MongoRepository` over a
// `@Document`) name no JPA entity and are left out. Accesses, as ACCESSES_DATA to the entity's DataModel (READS /
// WRITES to its table follow from `js-ts.data-access`):
//   - a derived query method (`findByEmailAndStatus`, `readBy`, `getBy`, `queryBy`, `searchBy`, `streamBy`, `existsBy`,
//     `countBy`, `deleteBy`, `removeBy`) from the method itself: `read`, `aggregate` (`count`), `delete`;
//   - a `@Query` method: JPQL against the entity names (`from`, `join`, `update`, `delete from`, `insert into`; joins of
//     `alias.relation` follow the relation's target; `#{#entityName}` is the repository's entity), or SQL with
//     `nativeQuery = true` through the SQL reader, the tables of the entities being their own DataModels; the
//     operation is the statement's, and `@Modifying` over a statement that only reads makes it an `update`;
//   - the inherited CRUD methods (`save`, `saveAll`, `saveAndFlush` `upsert`; `findById`, `findAll`, `findAllById`,
//     `existsById`, `getById`, `getReferenceById`, `getOne`, `findOne` `read`; `count` `aggregate`; `delete`,
//     `deleteById`, `deleteAll`, `deleteAllById`, `deleteInBatch`, `deleteAllInBatch` `delete`) from the function that
//     calls them on a field, parameter or local typed with the repository (found with `receivers.ts`), as these
//     methods are declared nowhere in the user's code. A declared method is reached through the call that
//     resolves to it, else directly from the caller.
// `EntityManager` (and Hibernate `Session`) calls: `persist` `create`, `merge` `upsert`, `remove` `delete`, `find`,
// `getReference`, `refresh` `read` of the entity of the class literal or of the argument's type, `createQuery` (JPQL) and
// `createNativeQuery` / `createSQLQuery` (SQL) with a literal or constant string, from the calling function.
// `nativeQuery` is a literal, `Boolean.TRUE` / `FALSE` or a boolean constant; when it is none of them, the
// query counts as native if the SQL reader finds a table in it, else as JPQL.
// A name from another package than `javax.persistence` / `jakarta.persistence` (an own `@Entity`) is no entity.
//
// Not handled: property access (annotations on getters), `@AttributeOverride`, composite `@JoinColumns`,
// `@OneToMany` join columns or tables, `@SecondaryTable`, `@ElementCollection`, a discriminator column,
// `orm.xml`, `@NamedQuery` / `@Query(name = …)`, `createNamedQuery`, `@Procedure`, Criteria API, Specifications, Querydsl,
// query-by-example, the Spring `JpaRepository` typed through its generic base at the use site
// (`BaseRepository<Customer, Long> repo`), repositories declared as classes, `@RepositoryDefinition`,
// fragments (`CustomerRepositoryCustom` + `Impl`), `@EnableJpaRepositories` filters, same-named entities of
// different packages in JPQL (the name is then left out), one table name in two schemas (one Table, the first
// schema stays), `JpaRepository` typed by a wildcard-imported
// scanned type that cannot be told from a framework one.
//
// A parse plugin keeps what the graph does not: the type arguments of an interface's `extends`
// (`javaJpaBases`), the `transient` modifier of a field (`javaJpaTransient`) and the arguments of
// persistence calls (`javaJpaArgs`); the contributor removes them.
//
// Bump `version` of the plugin when its parse output changes.

const JPA = ["javax.persistence", "jakarta.persistence"];
const HIBERNATE = ["org.hibernate.annotations"];
const SPRING_DATA = "org.springframework.data.";
const REPOSITORY_BASES = new Set(["Repository", "CrudRepository", "ListCrudRepository", "PagingAndSortingRepository", "ListPagingAndSortingRepository", "JpaRepository"]);
const CRUD_BASES = new Set(["CrudRepository", "ListCrudRepository", "PagingAndSortingRepository", "ListPagingAndSortingRepository", "JpaRepository"]);

// ---------------------------------------------------------------- parse plugin

const QUERY_METHODS = new Set(["createQuery", "createNativeQuery", "createSQLQuery"]);
const PERSISTENCE_CALLS = new Set(["persist", "merge", "remove", "find", "getReference", "refresh", "createQuery", "createNativeQuery", "createSQLQuery", "save", "saveOrUpdate", "update", "delete", "get", "load"]);

type JpaArg = { s: JavaStringTemplate } | { c: string } | { e: string };

const isMergeCall = (node: SyntaxNode): boolean => node.type === "method_invocation" && node.childForFieldName("name")?.text === "merge";

// Whether the `merge(...)` call is directly the argument of `remove(...)`, also through a conditional or parentheses.
function isRemoveOperand(merge: SyntaxNode): boolean {
  let current = merge;
  for (let parent = current.parent; parent; current = parent, parent = parent.parent) {
    if (parent.type === "parenthesized_expression") continue;
    if (parent.type === "ternary_expression" && parent.childForFieldName("condition")?.id !== current.id) continue;
    if (parent.type === "argument_list") {
      const call = parent.parent;
      return call?.type === "method_invocation" && call.childForFieldName("name")?.text === "remove" && parent.namedChildren[0]?.id === current.id;
    }
    return false;
  }
  return false;
}

// The expression whose entity `remove(arg)` deletes: for a conditional the branch that is not a `merge(...)`, for a
// `merge(x)` its argument.
function removedEntityOperand(arg: SyntaxNode): SyntaxNode {
  if (arg.type === "parenthesized_expression" && arg.namedChildren[0]) return removedEntityOperand(arg.namedChildren[0]);
  if (arg.type === "ternary_expression") {
    const branches = [arg.childForFieldName("consequence"), arg.childForFieldName("alternative")].filter((branch): branch is SyntaxNode => branch !== null);
    const plain = branches.find((branch) => !isMergeCall(branch));
    return removedEntityOperand(plain ?? branches[0] ?? arg);
  }
  if (isMergeCall(arg)) {
    const inner = arg.childForFieldName("arguments")?.namedChildren.find((child) => !child.type.endsWith("comment"));
    if (inner) return inner;
  }
  return arg;
}

const readJpaPlugin: JavaParsePlugin = ({ fileNodeId, root, nodes, functions }) => {
  if (!/persistence|springframework\.data|hibernate/u.test(root.text)) return;
  const own = (node: GraphNode) => node.id.startsWith(`${fileNodeId}:`);
  const interfaces = nodes.filter((node) => node.label === "Interface" && own(node));
  const fields = new Map<string, GraphNode>();
  for (const node of nodes) if (node.label === "Field" && own(node)) fields.set(`${node.properties.line}:${node.properties.name}`, node);
  const calls = new Map<string, GraphNode | null>();
  for (const node of nodes) {
    if (node.label !== "Call" || !own(node) || node.properties.callKind !== "method") continue;
    const key = `${node.properties.line}:${node.properties.columnNumber}:${node.properties.callee}`;
    // Two calls of one name at one position (`a.find(x).find(y)`) cannot be told apart.
    calls.set(key, calls.has(key) ? null : node);
  }
  const localStrings = new Map<SyntaxNode, JavaStringScope>();
  const localsAt = (node: SyntaxNode): JavaStringScope | undefined => {
    let best: SyntaxNode | null = null;
    for (const fn of functions) {
      const syntax = fn.syntax;
      if (syntax.startIndex <= node.startIndex && node.endIndex <= syntax.endIndex && (best === null || syntax.startIndex >= best.startIndex)) best = syntax;
    }
    if (!best) return undefined;
    let locals = localStrings.get(best);
    if (!locals) {
      const body = best.childForFieldName("body");
      const dynamic = body ? javaLocalNames([body]) : undefined;
      locals = body ? { locals: readLocalStrings([body], dynamic), dynamic } : {};
      localStrings.set(best, locals);
    }
    return locals;
  };

  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const child of node.namedChildren) stack.push(child);
    if (node.type === "interface_declaration") {
      const name = node.childForFieldName("name")?.text;
      const target = interfaces.find((candidate) => candidate.properties.name === name && candidate.properties.line === node.startPosition.row + 1);
      const extended = node.namedChildren.find((child) => child.type === "extends_interfaces");
      const list = extended?.namedChildren.find((child) => child.type === "type_list");
      if (target && list) target.properties.javaJpaBases = JSON.stringify(list.namedChildren.filter((child) => !child.type.endsWith("comment")).map((child) => compactExpression(child.text)));
    } else if (node.type === "field_declaration") {
      if (!modifiersOf(node).words.has("transient")) continue;
      for (const declarator of node.childrenForFieldName("declarator")) {
        const name = declarator.childForFieldName("name")?.text;
        const field = name ? fields.get(`${declarator.startPosition.row + 1}:${name}`) : undefined;
        if (field) field.properties.javaJpaTransient = true;
      }
    } else if (node.type === "method_invocation") {
      const callee = node.childForFieldName("name")?.text;
      if (!callee || !PERSISTENCE_CALLS.has(callee)) continue;
      const call = calls.get(`${node.startPosition.row + 1}:${node.startPosition.column}:${callee}`);
      if (!call) continue;
      const args = (node.childForFieldName("arguments")?.namedChildren ?? []).filter((arg) => !arg.type.endsWith("comment")).slice(0, 2);
      // `em.remove(em.contains(x) ? x : em.merge(x))`: the `merge` only re-attaches the entity the `remove` deletes,
      // so it is no write (no arguments are kept, the contributor skips it), and the removed entity is the one the
      // branches name.
      if (callee === "merge" && isRemoveOperand(node)) continue;
      if (callee === "remove" && args[0]) args[0] = removedEntityOperand(args[0]);
      const read = args.map((arg): JpaArg => {
        if (arg.type === "class_literal") return { c: compactExpression(arg.text).replace(/\.class$/u, "") };
        if (QUERY_METHODS.has(callee) && arg === args[0]) {
          const template = readJavaString(arg, localsAt(arg));
          if (template) return { s: template };
        }
        return { e: compactExpression(arg.text) };
      });
      if (read.length > 0) call.properties.javaJpaArgs = JSON.stringify(read);
    }
  }
};

export const javaDataJpaPlugin: JavaParsePlugin & { version: string } = Object.assign<JavaParsePlugin, { version: string }>(readJpaPlugin, { version: "4" });

// ---------------------------------------------------------------- helpers

const snake = (name: string): string => name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2").toLowerCase();

function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "<") depth += 1;
    else if (text[i] === ">") depth -= 1;
    else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

// `Optional<Foo>` -> name `Optional`, args [`Foo`].
function genericParts(text: string): { name: string; args: string[] } {
  const cleaned = text.replace(/@[\p{L}\p{N}_$.]+(?:\s*\([^)]*\))?/gu, " ").replace(/\s+/gu, " ").trim();
  const open = cleaned.indexOf("<");
  if (open < 0 || !cleaned.endsWith(">")) return { name: cleaned, args: [] };
  return { name: cleaned.slice(0, open).trim(), args: splitTop(cleaned.slice(open + 1, -1)) };
}

const PRIMITIVES = new Set(["int", "long", "short", "byte", "char", "boolean", "float", "double"]);
const COLLECTIONS = new Set(["List", "Set", "Collection", "Iterable", "SortedSet", "Map", "SortedMap", "Queue", "Deque"]);

function stringArg(ann: JavaAnnotationInfo | undefined, key: string): string | null {
  const value = ann ? annotationValue(ann, key)?.[0] : undefined;
  return value?.resolved ? value.value : null;
}

// Spring Boot's physical naming for an explicit name: snake_case, unless the name is quoted.
const physical = (name: string): string => (/["`]/u.test(name) ? name.replace(/["`]/gu, "") : snake(name));

const flagArg = (ann: JavaAnnotationInfo | undefined, key: string): boolean | null => {
  const value = ann ? annotationEnum(ann, key)?.[0] : undefined;
  return value === "true" ? true : value === "false" ? false : null;
};

type Column = { name: string; column: string; type: string | null; optional: boolean; list: boolean; isId: boolean; isUnique: boolean; references?: string };

type FieldInfo = { node: GraphNode; owner: JavaType; name: string; type: string; declared: string; line: number; anns: JavaAnnotationInfo[] };

type Relation = { field: FieldInfo; kind: "one" | "many"; via: "ManyToOne" | "OneToOne" | "OneToMany" | "ManyToMany"; mappedBy: string | null; target: JavaType | null; ann: JavaAnnotationInfo };

type Entity = {
  type: JavaType;
  entityName: string;
  root: Entity;
  strategy: "SINGLE_TABLE" | "JOINED" | "TABLE_PER_CLASS";
  tableName: string;
  schema: string | null;
  tableId: string;
  modelId: string;
};

type Repository = { type: JavaType; entity: Entity | null; crud: boolean };

type CallInfo = { call: GraphNode; fn: GraphNode; fileId: string; typeId: string };

const RELATIONS: ReadonlyArray<Relation["via"]> = ["ManyToOne", "OneToOne", "OneToMany", "ManyToMany"];

// ---------------------------------------------------------------- JPQL

const JPQL_KEYWORDS = new Set(["where", "join", "left", "right", "inner", "outer", "cross", "full", "on", "set", "order", "group", "having", "with", "fetch", "values", "select", "as", "union", "from", "into", "update", "delete", "insert", "and", "or", "not", "in", "is", "like", "between", "member", "of"]);

type JpqlSource = { name: string; alias: string | null; join: boolean };

// Entity names and aliases of a JPQL statement, in order of appearance: after `from`, `update`, `into` and `join`.
function jpqlSources(jpql: string): { verb: "select" | "update" | "delete" | "insert"; aggregate: boolean; sources: JpqlSource[] } {
  const text = jpql.replace(/'(?:[^']|'')*'/gu, "''").replace(/\s+/gu, " ").trim();
  const head = /^\(?\s*(select|update|delete|insert|from)\b/iu.exec(text)?.[1]?.toLowerCase();
  const verb = head === "update" || head === "delete" || head === "insert" ? head : "select";
  let aggregate = false;
  if (verb === "select") {
    const clause = /^select\s+(?:distinct\s+)?(.*?)\s+from\b/iu.exec(text)?.[1];
    aggregate = clause !== undefined && /^(?:count|sum|avg|min|max)\s*\((?:[^()]|\([^()]*\))*\)$/iu.test(clause);
  }
  const sources: JpqlSource[] = [];
  const name = String.raw`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`;
  const entry = new RegExp(String.raw`\s*(${name})(?:\s+(?:as\s+)?([A-Za-z_$][\w$]*))?`, "iyu");
  // `delete Entity e where …`: the entity follows `delete` directly.
  if (verb === "delete" && !/^\(?\s*delete\s+from\b/iu.test(text)) {
    entry.lastIndex = text.search(/delete/iu) + 6;
    const found = entry.exec(text);
    if (found) sources.push({ name: found[1]!, alias: found[2] && !JPQL_KEYWORDS.has(found[2].toLowerCase()) ? found[2] : null, join: false });
  }
  for (const match of text.matchAll(/\b(from|update|into|join)\s+(?:fetch\s+)?/giu)) {
    const keyword = match[1]!.toLowerCase();
    let at = match.index + match[0].length;
    for (;;) {
      entry.lastIndex = at;
      const found = entry.exec(text);
      if (!found) break;
      const alias = found[2] && !JPQL_KEYWORDS.has(found[2].toLowerCase()) ? found[2] : null;
      sources.push({ name: found[1]!, alias, join: keyword === "join" });
      at = entry.lastIndex;
      // `from A a, B b`: further sources of the same clause.
      if (keyword === "join" || !/^\s*,/u.test(text.slice(at))) break;
      at += text.slice(at).indexOf(",") + 1;
    }
  }
  return { verb, aggregate, sources };
}

// ---------------------------------------------------------------- contributor

export const javaDataJpaContributor: ISemanticContributor = {
  id: "java.data-jpa",
  contribute(graph) {
    const reader = javaAnnotationReader(graph);
    const index = createResolutionRelationshipIndex(graph);
    const types = createJavaTypeIndex(graph, index);
    const strings = createJavaStringResolver(graph);
    const receivers = createJavaReceiverResolver(graph);
    const methods = new Map(javaMethods(graph).map((method) => [method.node.id, method]));
    // A name argument of a mapping annotation: a literal, or a constant the string resolver follows.
    const nameArg = (ann: JavaAnnotationInfo | undefined, key: string, owner: JavaType): string | null => {
      const value = ann ? annotationValue(ann, key)?.[0] : undefined;
      if (!value) return null;
      if (value.resolved) return value.value || null;
      const template = javaStringFromText(value.value);
      if (!template) return null;
      const parts = strings.resolveParts(template, { fileId: owner.fileId, typeId: owner.id });
      return parts.every((part) => "text" in part) ? parts.map((part) => ("text" in part ? part.text : "")).join("") || null : null;
    };
    // An explicit name in Spring Boot's physical naming (`physical`); null when absent, empty or unknown.
    const explicitName = (ann: JavaAnnotationInfo | undefined, key: string, owner: JavaType): string | null => {
      const name = nameArg(ann, key, owner);
      return name ? physical(name) : null;
    };
    // `nativeQuery`: a literal, `Boolean.TRUE` / `FALSE` or a boolean constant; null when unknown.
    const nativeFlag = (ann: JavaAnnotationInfo, owner: JavaType): boolean | null => {
      const text = annotationValue(ann, "nativeQuery")?.[0]?.value.trim();
      if (text === undefined) return false;
      const bool = (value: string): boolean | null => (/^(?:java\.lang\.)?Boolean\.TRUE$|^true$/u.test(value) ? true : /^(?:java\.lang\.)?Boolean\.FALSE$|^false$/u.test(value) ? false : null);
      const direct = bool(text);
      if (direct !== null) return direct;
      const constant = strings.constant(text, { fileId: owner.fileId, typeId: owner.id });
      const rendered = constant?.every((part) => "text" in part) ? constant.map((part) => ("text" in part ? part.text : "")).join("").trim() : null;
      return rendered === null ? null : bool(rendered);
    };

    // The temporary properties of the parse plugin are read, then removed.
    const basesOf = new Map<string, string[]>();
    for (const node of graph.nodesWithLabel("Interface")) {
      if (typeof node.properties.javaJpaBases === "string") basesOf.set(node.id, parseStringList(node.properties.javaJpaBases));
      delete node.properties.javaJpaBases;
    }
    const transientFields = new Set<string>();
    for (const node of graph.nodesWithLabel("Field")) {
      if (node.properties.javaJpaTransient === true) transientFields.add(node.id);
      delete node.properties.javaJpaTransient;
    }
    const callArgs = new Map<string, JpaArg[]>();
    for (const node of graph.nodesWithLabel("Call")) {
      if (typeof node.properties.javaJpaArgs === "string") {
        try {
          callArgs.set(node.id, JSON.parse(node.properties.javaJpaArgs) as JpaArg[]);
        } catch {
          // Unreadable arguments count as none.
        }
      }
      delete node.properties.javaJpaArgs;
    }

    const relativeOf = (fileId: string): string => String(graph.node(fileId)?.properties.relativePath ?? fileId.replace(/^file:/u, ""));
    const fieldsByType = new Map<string, FieldInfo[]>();
    for (const rel of graph.relationshipsOfType("DEFINES_FIELD")) {
      const owner = types.byId.get(rel.from);
      const node = graph.node(rel.to);
      if (!owner || !node) continue;
      const list = fieldsByType.get(owner.id) ?? [];
      const typeName = String(node.properties.typeName ?? "");
      list.push({ node, owner, name: String(node.properties.name), type: typeName, declared: String(node.properties.declaredType ?? typeName), line: Number(node.properties.line), anns: reader.annotationsOf(node) });
      fieldsByType.set(owner.id, list);
    }
    for (const list of fieldsByType.values()) list.sort((a, b) => a.line - b.line);
    const superclassOf = (type: JavaType): JavaType | null => (type.isInterface ? null : types.supertypes(type).find((parent) => !parent.isInterface) ?? null);

    // ---- entities
    const jpaKind = (type: JavaType): "entity" | "mapped" | "embeddable" | null => {
      if (type.isInterface || type.node.properties.kind !== "class") return null;
      const list = reader.annotationsOf(type.node);
      if (hasAnnotation(list, "Entity", JPA)) return "entity";
      if (hasAnnotation(list, "MappedSuperclass", JPA)) return "mapped";
      if (hasAnnotation(list, "Embeddable", JPA)) return "embeddable";
      return null;
    };
    const kinds = new Map<string, "entity" | "mapped" | "embeddable">();
    for (const type of types.types) {
      const kind = jpaKind(type);
      if (kind) kinds.set(type.id, kind);
    }
    const entityTypes = types.types.filter((type) => kinds.get(type.id) === "entity");
    const annotationsOf = (type: JavaType) => reader.annotationsOf(type.node);
    const entityNameOf = (type: JavaType): string => nameArg(findAnnotations(annotationsOf(type), "Entity", JPA)[0], "name", type) ?? type.name;

    // The topmost @Entity of the superclass chain, through @MappedSuperclass classes.
    const rootOf = (type: JavaType): JavaType => {
      let root = type;
      for (let current = superclassOf(type), guard = 0; current && guard < 32; current = superclassOf(current), guard += 1) {
        if (kinds.get(current.id) === "entity") root = current;
        else if (kinds.get(current.id) !== "mapped") break;
      }
      return root;
    };
    const strategyOf = (root: JavaType): Entity["strategy"] => {
      const ann = findAnnotations(annotationsOf(root), "Inheritance", JPA)[0];
      const value = ann ? annotationEnum(ann, "strategy")?.[0] : undefined;
      return value === "JOINED" || value === "TABLE_PER_CLASS" ? value : "SINGLE_TABLE";
    };

    const entities = new Map<string, Entity>();
    const byEntityName = new Map<string, Entity[]>();
    for (const type of entityTypes) {
      const root = rootOf(type);
      const strategy = strategyOf(root);
      const ownTable = root.id === type.id || strategy !== "SINGLE_TABLE";
      const tableType = ownTable ? type : root;
      const tableAnn = findAnnotations(annotationsOf(tableType), "Table", JPA)[0];
      const tableName = explicitName(tableAnn, "name", tableType) ?? snake(entityNameOf(tableType));
      const entity: Entity = {
        type,
        entityName: entityNameOf(type),
        root: undefined as unknown as Entity,
        strategy,
        tableName: normalizeTableName(tableName),
        schema: nameArg(tableAnn, "schema", tableType),
        tableId: "",
        modelId: javaDataModelId("jpa", type.name, type.packageName),
      };
      entities.set(type.id, entity);
      byEntityName.set(entity.entityName, [...byEntityName.get(entity.entityName) ?? [], entity]);
    }
    for (const entity of entities.values()) entity.root = entities.get(rootOf(entity.type).id)!;

    const visibleType = (name: string, owner: JavaType): JavaType | null => types.resolve(name, { fileId: owner.fileId, typeId: owner.id });
    const columnName = (field: FieldInfo): string => explicitName(findAnnotations(field.anns, "Column", JPA)[0], "name", field.owner) ?? snake(field.name);
    const isStaticOrTransient = (field: FieldInfo): boolean => field.node.properties.isStatic === true || transientFields.has(field.node.id) || hasAnnotation(field.anns, "Transient", JPA);
    const isCollection = (field: FieldInfo): boolean => COLLECTIONS.has(field.type.split(".").at(-1)!) || (field.type.endsWith("[]") && !/^(?:byte|char|Byte|Character)\[\]$/u.test(field.type));
    const relationOf = (field: FieldInfo): Relation | null => {
      for (const via of RELATIONS) {
        const ann = findAnnotations(field.anns, via, JPA)[0];
        if (!ann) continue;
        const written = via === "ManyToOne" || via === "OneToOne" ? field.type : genericParts(field.declared).args.at(-1)?.replace(/^\?\s*(?:extends|super)\s+/u, "") ?? field.type;
        const name = normalizeJavaType(written);
        const target = name ? visibleType(name, field.owner) : null;
        return { field, kind: via === "ManyToOne" || via === "OneToOne" ? "one" : "many", via, mappedBy: stringArg(ann, "mappedBy"), target: target && kinds.get(target.id) === "entity" ? target : null, ann };
      }
      return null;
    };
    // The fields a class (and its @MappedSuperclass ancestors) maps, superclass fields first.
    const mappedChain = (type: JavaType): JavaType[] => {
      const chain = [type];
      for (let current = superclassOf(type), guard = 0; current && kinds.get(current.id) === "mapped" && guard < 32; current = superclassOf(current), guard += 1) chain.unshift(current);
      return chain;
    };
    const mappedFields = (type: JavaType): FieldInfo[] => mappedChain(type).flatMap((member) => fieldsByType.get(member.id) ?? []).filter((field) => !isStaticOrTransient(field));
    const idColumnOf = (entity: Entity): string => {
      for (let current: JavaType | null = entity.type, guard = 0; current && guard < 32; current = superclassOf(current), guard += 1) {
        const found = mappedFields(current).find((field) => hasAnnotation(field.anns, "Id", JPA) || hasAnnotation(field.anns, "EmbeddedId", JPA));
        if (found) return columnName(found);
      }
      return "id";
    };
    const tableNameOf = (entity: Entity): string => entity.tableName;

    const basicColumn = (field: FieldInfo, extra: Partial<Column> = {}): Column => {
      const column = findAnnotations(field.anns, "Column", JPA)[0];
      const isId = hasAnnotation(field.anns, "Id", JPA);
      const nullable = flagArg(column, "nullable");
      return {
        name: field.name,
        column: columnName(field),
        type: field.type || null,
        optional: !(isId || nullable === false || PRIMITIVES.has(field.type)),
        list: false,
        isId,
        isUnique: isId || flagArg(column, "unique") === true,
        ...extra,
      };
    };
    const columnsOfFields = (type: JavaType, fields: readonly FieldInfo[], depth: number, seen: ReadonlySet<string>, embeddedId = false): Column[] => {
      const columns: Column[] = [];
      for (const field of fields) {
        if (hasAnnotation(field.anns, "ElementCollection", JPA)) continue;
        const relation = relationOf(field);
        if (relation) {
          if (relation.mappedBy !== null || relation.kind === "many") continue;
          const joinAnn = findAnnotations(field.anns, "JoinColumn", JPA)[0];
          const target = relation.target ? entities.get(relation.target.id) : undefined;
          const refColumn = explicitName(joinAnn, "referencedColumnName", field.owner) ?? (target ? idColumnOf(target) : "id");
          const optional = flagArg(relation.ann, "optional") !== false && flagArg(joinAnn, "nullable") !== false;
          columns.push({
            name: field.name,
            column: explicitName(joinAnn, "name", field.owner) ?? `${snake(field.name)}_${refColumn}`,
            type: relation.target?.name ?? field.type,
            optional,
            list: false,
            isId: false,
            isUnique: relation.via === "OneToOne" || flagArg(joinAnn, "unique") === true,
            ...(target ? { references: `${tableNameOf(target)}.${refColumn}` } : {}),
          });
          continue;
        }
        const embeddedName = normalizeJavaType(field.type);
        const embeddable = embeddedName ? visibleType(embeddedName, type) : null;
        const isEmbedded = hasAnnotation(field.anns, "Embedded", JPA) || hasAnnotation(field.anns, "EmbeddedId", JPA) || (embeddable !== null && kinds.get(embeddable.id) === "embeddable");
        if (isEmbedded) {
          if (!embeddable || kinds.get(embeddable.id) !== "embeddable" || depth >= 4 || seen.has(embeddable.id)) continue;
          const asId = embeddedId || hasAnnotation(field.anns, "EmbeddedId", JPA);
          const inner = columnsOfFields(embeddable, mappedFields(embeddable), depth + 1, new Set([...seen, embeddable.id]), asId);
          columns.push(...inner.map((column) => (asId ? { ...column, isId: true, optional: false } : column)));
          continue;
        }
        if (isCollection(field) && !hasAnnotation(field.anns, "Column", JPA)) continue;
        columns.push(basicColumn(field, embeddedId ? { isId: true, optional: false } : {}));
      }
      return columns;
    };
    // The columns an entity's own fields (with its @MappedSuperclass ancestors') map.
    const ownColumns = (entity: Entity): Column[] => columnsOfFields(entity.type, mappedFields(entity.type), 0, new Set([entity.type.id]));
    const entityAncestors = (entity: Entity): Entity[] => {
      const result: Entity[] = [];
      for (let current = superclassOf(entity.type), guard = 0; current && guard < 32; current = superclassOf(current), guard += 1) {
        const parent = entities.get(current.id);
        if (parent) result.unshift(parent);
      }
      return result;
    };
    const tableColumns = (entity: Entity): Column[] => {
      const all: Column[] = [];
      if (entity.strategy === "TABLE_PER_CLASS") for (const parent of entityAncestors(entity)) all.push(...ownColumns(parent));
      all.push(...ownColumns(entity));
      if (entity.root === entity && entity.strategy === "SINGLE_TABLE") {
        for (const other of entities.values()) if (other !== entity && other.root === entity) all.push(...ownColumns(other));
      }
      const seen = new Set<string>();
      return all.filter((column) => {
        const key = column.column.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    // ---- tables, models, relations
    const modelByTable = new Map<string, string>();
    for (const entity of entities.values()) {
      const ownTable = entity.root === entity || entity.strategy !== "SINGLE_TABLE";
      const declaredIn = relativeOf(entity.type.fileId);
      const line = Number(entity.type.node.properties.line);
      if (ownTable) {
        entity.tableId = javaTable(graph, entity.tableName, { library: "jpa", schemaName: entity.schema, declaredIn, line, columns: tableColumns(entity) });
      } else {
        entity.tableId = entity.root.tableId || javaTable(graph, entity.root.tableName, { library: "jpa", schemaName: entity.root.schema, declaredIn: relativeOf(entity.root.type.fileId), line: Number(entity.root.type.node.properties.line), columns: tableColumns(entity.root) });
      }
    }
    // Subclasses of a single table were created after their root or before it: make them agree.
    for (const entity of entities.values()) if (entity.root !== entity && entity.strategy === "SINGLE_TABLE") entity.tableId = entity.root.tableId;
    for (const entity of entities.values()) {
      javaDataModel(graph, { name: entity.type.name, library: "jpa", scope: entity.type.packageName, declaredIn: relativeOf(entity.type.fileId), line: Number(entity.type.node.properties.line), table: entity.tableId });
      if (!modelByTable.has(entity.tableName.toLowerCase())) modelByTable.set(entity.tableName.toLowerCase(), entity.modelId);
    }

    const relationKeys = new Set<string>();
    const relate = (from: string, to: string, field: string, kind: "one" | "many", fields: string[], onDelete: string | null) => {
      const key = `${from}\0${to}\0${field}`;
      if (relationKeys.has(key)) return;
      relationKeys.add(key);
      graph.addRelationship({ from, to, type: "RELATES_TO", properties: { field, kind, fields: JSON.stringify(fields), references: "[]", relationName: null, onDelete } });
    };
    for (const entity of entities.values()) {
      for (const field of mappedFields(entity.type)) {
        const relation = relationOf(field);
        if (!relation?.target) continue;
        const target = entities.get(relation.target.id)!;
        const joinAnn = findAnnotations(field.anns, "JoinColumn", JPA)[0];
        const owner = relation.mappedBy === null;
        let foreignKeys: string[] = [];
        if (owner && relation.kind === "one") foreignKeys = [explicitName(joinAnn, "name", field.owner) ?? `${snake(field.name)}_${explicitName(joinAnn, "referencedColumnName", field.owner) ?? idColumnOf(target)}`];
        const onDeleteValue = annotationEnum(findAnnotations(field.anns, "OnDelete", HIBERNATE)[0] ?? { args: [] }, "action")?.[0];
        relate(entity.modelId, target.modelId, field.name, relation.kind, foreignKeys, onDeleteValue ?? null);

        // The join table of the owning side of a many-to-many.
        if (relation.via === "ManyToMany" && owner) {
          const joinTable = findAnnotations(field.anns, "JoinTable", JPA)[0];
          const names = (key: string): string[] => (annotationValue(joinTable ?? { args: [] }, key) ?? []).flatMap((value) => [...value.value.matchAll(/\bname\s*=\s*"((?:[^"\\]|\\.)*)"/gu)].map((match) => physical(match[1]!.replace(/\\"/gu, '"'))));
          const ownerPk = idColumnOf(entity);
          const targetPk = idColumnOf(target);
          const joinName = explicitName(joinTable, "name", field.owner) ?? `${entity.tableName}_${target.tableName}`;
          const left = names("joinColumns")[0] ?? `${snake(entity.entityName)}_${ownerPk}`;
          const right = names("inverseJoinColumns")[0] ?? `${snake(field.name)}_${targetPk}`;
          const column = (name: string, type: string, references: string): Column => ({ name, column: name, type, optional: false, list: false, isId: false, isUnique: false, references });
          javaTable(graph, joinName, {
            library: "jpa",
            schemaName: nameArg(joinTable, "schema", field.owner),
            declaredIn: relativeOf(field.owner.fileId),
            line: field.line,
            columns: [column(left, "Long", `${entity.tableName}.${ownerPk}`), column(right, "Long", `${target.tableName}.${targetPk}`)],
          });
        }
      }
    }

    // ---- repositories
    const importsByFile = new Map<string, Array<{ source: string; wildcard: boolean }>>();
    for (const rel of graph.relationshipsOfType("IMPORTS")) {
      const node = graph.node(rel.to);
      if (!node || node.properties.isStatic === true || typeof node.properties.source !== "string") continue;
      importsByFile.set(rel.from, [...importsByFile.get(rel.from) ?? [], { source: node.properties.source, wildcard: node.properties.isWildcard === true }]);
    }
    // The simple name of the Spring Data repository interface a written name stands for; null otherwise.
    const springBase = (written: string, fileId: string): string | null => {
      const simple = written.split(".").at(-1)!;
      if (!REPOSITORY_BASES.has(simple)) return null;
      const imports = importsByFile.get(fileId) ?? [];
      if (/^[a-z]/u.test(written) && written.includes(".")) return written.startsWith(SPRING_DATA) ? simple : null;
      const single = imports.find((entry) => !entry.wildcard && entry.source.split(".").at(-1) === written.split(".")[0]);
      if (single) return `${single.source}${written.slice(written.split(".")[0]!.length)}`.startsWith(SPRING_DATA) ? simple : null;
      return imports.some((entry) => entry.wildcard && entry.source.startsWith(SPRING_DATA.slice(0, -1))) ? simple : null;
    };

    type Binding = { text: string; scope: JavaType };
    type Found = { entityText: Binding | null; crud: boolean };
    const resolveBases = (type: JavaType, bindings: ReadonlyMap<string, Binding>, depth: number, seen: ReadonlySet<string>): Found | null => {
      if (depth > 8 || seen.has(type.id)) return null;
      let result: Found | null = null;
      for (const base of basesOf.get(type.id) ?? []) {
        const { name, args } = genericParts(base);
        const bound = args.map((arg): Binding => bindings.get(arg) ?? { text: arg, scope: type });
        const scanned = visibleType(name, type);
        let found: Found | null = null;
        if (scanned) {
          if (!scanned.isInterface) continue;
          const params = parseStringList(scanned.node.properties.typeParameters).map((param) => param.split(/\s+/u)[0]!);
          const inner = new Map<string, Binding>();
          params.forEach((param, i) => {
            if (bound[i]) inner.set(param, bound[i]!);
          });
          found = resolveBases(scanned, inner, depth + 1, new Set([...seen, type.id]));
        } else {
          const simple = springBase(name, type.fileId);
          if (simple) found = { entityText: bound[0] ?? null, crud: CRUD_BASES.has(simple) };
        }
        if (!found) continue;
        result = result ? { entityText: result.entityText ?? found.entityText, crud: result.crud || found.crud } : found;
      }
      return result;
    };
    const repositories = new Map<string, Repository>();
    for (const type of types.types) {
      if (!type.isInterface || !basesOf.has(type.id)) continue;
      const found = resolveBases(type, new Map(), 0, new Set());
      if (!found) continue;
      let entity: Entity | null = null;
      if (found.entityText) {
        const name = normalizeJavaType(found.entityText.text);
        const target = name ? visibleType(name, found.entityText.scope) : null;
        entity = target ? entities.get(target.id) ?? null : null;
      }
      repositories.set(type.id, { type, entity, crud: found.crud });
    }
    for (const repository of repositories.values()) {
      if (!repository.entity) continue;
      const id = javaDataModel(graph, { name: repository.type.name, library: "spring-data", scope: repository.type.packageName, declaredIn: relativeOf(repository.type.fileId), line: Number(repository.type.node.properties.line), table: repository.entity.tableId });
      relate(id, repository.entity.modelId, "entity", "one", [], null);
    }

    // ---- access sites
    const accesses: JavaDataAccess[] = [];
    const entityNamed = (name: string, from: JavaType | null): Entity | null => {
      const list = byEntityName.get(name) ?? (name.includes(".") ? entityTypes.filter((type) => type.qualifiedName === name).flatMap((type) => entities.get(type.id) ?? []) : []);
      if (list.length === 1) return list[0]!;
      const samePackage = from ? list.filter((entity) => entity.type.packageName === from.packageName) : [];
      return samePackage.length === 1 ? samePackage[0]! : null;
    };
    const relationTarget = (entity: Entity, field: string): Entity | null => {
      for (const member of mappedFields(entity.type)) {
        if (member.name !== field) continue;
        const target = relationOf(member)?.target;
        return target ? entities.get(target.id) ?? null : null;
      }
      return null;
    };
    const jpqlAccesses = (jpql: string, from: JavaType | null, own: Entity | null): Array<{ modelId: string; operation: JavaDataOperation }> => {
      const text = own ? jpql.replace(/#\{#entityName\}/gu, own.entityName) : jpql;
      const { verb, aggregate, sources } = jpqlSources(text);
      const aliases = new Map<string, Entity>();
      const result: Array<{ modelId: string; operation: JavaDataOperation }> = [];
      let primaryDone = false;
      for (const source of sources) {
        let entity: Entity | null = null;
        const dot = source.name.indexOf(".");
        if (source.join && dot > 0 && aliases.has(source.name.slice(0, dot))) entity = relationTarget(aliases.get(source.name.slice(0, dot))!, source.name.slice(dot + 1).split(".")[0]!);
        else entity = entityNamed(source.name, from);
        if (!entity) {
          // An unknown first source still uses up the statement's own operation.
          if (!source.join) primaryDone = true;
          continue;
        }
        if (source.alias) aliases.set(source.alias, entity);
        let operation: JavaDataOperation = "read";
        if (!primaryDone && !source.join) {
          operation = verb === "update" ? "update" : verb === "delete" ? "delete" : verb === "insert" ? "create" : aggregate ? "aggregate" : "read";
        }
        if (!source.join) primaryDone = true;
        if (!result.some((item) => item.modelId === entity!.modelId && item.operation === operation)) result.push({ modelId: entity.modelId, operation });
      }
      return result;
    };
    // Native SQL: the entity's own DataModel for a table an entity maps, else the stand-in of the table.
    const sqlModels = (sql: string): Array<{ modelId: string; operation: JavaDataOperation }> =>
      sqlAccesses(sql).map((access) => {
        const known = modelByTable.get(normalizeTableName(access.table).toLowerCase());
        if (known) return { modelId: known, operation: access.operation };
        return { modelId: javaTableModel(graph, javaTable(graph, access.table, { library: "jpa" }), "jpa"), operation: access.operation };
      });
    const stringOf = (template: JavaStringTemplate, scope: JavaType): string | null => strings.resolve(template, { fileId: scope.fileId, typeId: scope.id });
    const lineOf = (node: GraphNode): number => Number(node.properties.line);

    // Declared methods of the repositories: derived queries and @Query.
    const DERIVED = /^(find|read|get|query|search|stream|count|exists|delete|remove)(.*?)By(?=\p{Lu}|\p{N}|$)/u;
    const declaredAccess = new Map<string, Array<{ fn: GraphNode; accesses: Array<{ modelId: string; operation: JavaDataOperation }> }>>();
    const functionsOfType = new Map<string, GraphNode[]>();
    for (const rel of graph.relationshipsOfType("DEFINES_INTERFACE_METHOD" as GraphRelationship["type"])) {
      const fn = graph.node(rel.to);
      if (fn) functionsOfType.set(rel.from, [...functionsOfType.get(rel.from) ?? [], fn]);
    }
    for (const repository of repositories.values()) {
      const entity = repository.entity;
      if (!entity) continue;
      const list: Array<{ fn: GraphNode; accesses: Array<{ modelId: string; operation: JavaDataOperation }> }> = [];
      for (const fn of functionsOfType.get(repository.type.id) ?? []) {
        if (fn.properties.kind !== "method" || fn.properties.isStatic === true || fn.properties.isAbstract !== true) continue;
        const anns = reader.annotationsOf(fn);
        const query = findAnnotations(anns, "Query", ["org.springframework.data.jpa.repository", "org.springframework.data.mongodb.repository"])[0];
        let found: Array<{ modelId: string; operation: JavaDataOperation }> = [];
        if (query) {
          if (query.qualifiedName?.includes("mongodb")) continue;
          const native = nativeFlag(query, repository.type);
          // `value` and `countQuery` are both statements of the method; read alike.
          const read = (attribute: string): Array<{ modelId: string; operation: JavaDataOperation }> => {
            const value = annotationValue(query, attribute)?.[0];
            if (!value) return [];
            const template = value.resolved ? null : javaStringFromText(value.value);
            const sql = value.resolved ? value.value : template ? stringOf(template, repository.type) : null;
            if (!sql) return [];
            return native === true ? sqlModels(sql) : native === false ? jpqlAccesses(sql, repository.type, entity) : (() => {
              const asSql = sqlModels(sql);
              return asSql.length > 0 ? asSql : jpqlAccesses(sql, repository.type, entity);
            })();
          };
          found = read("value");
          if (hasAnnotation(anns, "Modifying", ["org.springframework.data.jpa.repository"]) && found.length > 0 && found.every((item) => item.operation === "read")) found = [{ ...found[0]!, operation: "update" }, ...found.slice(1)];
          for (const access of read("countQuery")) if (!found.some((item) => item.modelId === access.modelId && item.operation === access.operation)) found.push(access);
        } else {
          const match = DERIVED.exec(String(fn.properties.name));
          if (!match) continue;
          const prefix = match[1]!;
          found = [{ modelId: entity.modelId, operation: prefix === "count" ? "aggregate" : prefix === "delete" || prefix === "remove" ? "delete" : "read" }];
        }
        if (found.length === 0) continue;
        list.push({ fn, accesses: found });
        for (const access of found) accesses.push({ functionId: fn.id, modelId: access.modelId, operation: access.operation, library: "jpa", line: lineOf(fn), expression: `${repository.type.name}.${String(fn.properties.name)}` });
      }
      if (list.length > 0) declaredAccess.set(repository.type.id, list);
    }
    const declaredOf = (type: JavaType): Array<{ fn: GraphNode; accesses: Array<{ modelId: string; operation: JavaDataOperation }> }> => {
      const result: Array<{ fn: GraphNode; accesses: Array<{ modelId: string; operation: JavaDataOperation }> }> = [...declaredAccess.get(type.id) ?? []];
      for (const parent of types.supertypes(type)) if (parent.isInterface) result.push(...declaredOf(parent));
      return result;
    };

    // Calls.
    const callerOf = new Map<string, GraphNode>();
    for (const rel of graph.relationshipsOfType("CALLS")) {
      const fn = graph.node(rel.from);
      if (fn && methods.has(fn.id)) callerOf.set(rel.to, fn);
    }
    const resolvedCalls = new Map<string, Set<string>>();
    for (const rel of graph.relationshipsOfType("CALL_RESOLVES_TO")) resolvedCalls.set(rel.from, new Set([...resolvedCalls.get(rel.from) ?? [], rel.to]));

    const CRUD: Record<string, JavaDataOperation> = {
      save: "upsert", saveAll: "upsert", saveAndFlush: "upsert", saveAllAndFlush: "upsert",
      findById: "read", findAll: "read", findAllById: "read", existsById: "read", getById: "read", getReferenceById: "read", getOne: "read", findOne: "read",
      count: "aggregate",
      delete: "delete", deleteById: "delete", deleteAll: "delete", deleteAllById: "delete", deleteInBatch: "delete", deleteAllInBatch: "delete", deleteAllByIdInBatch: "delete",
    };
    const EM = ["jakarta.persistence.EntityManager", "javax.persistence.EntityManager"];
    const SESSION = ["org.hibernate.Session", "org.hibernate.StatelessSession"];
    const EM_OPERATIONS: Record<string, JavaDataOperation> = { persist: "create", merge: "upsert", remove: "delete", find: "read", getReference: "read", refresh: "read" };
    const SESSION_OPERATIONS: Record<string, JavaDataOperation> = { save: "create", saveOrUpdate: "upsert", persist: "create", merge: "upsert", update: "update", delete: "delete", remove: "delete", get: "read", load: "read", find: "read", refresh: "read" };

    for (const call of graph.nodesWithLabel("Call")) {
      if (call.properties.callKind !== "method") continue;
      const callee = String(call.properties.callee);
      const fn = callerOf.get(call.id);
      const method = fn ? methods.get(fn.id) : undefined;
      if (!fn || !method) continue;
      const receiver = receivers.typeOfCall(call, fn);
      if (!receiver) continue;
      const base = { callId: call.id, library: "jpa", line: call.properties.line, expression: call.properties.expression };

      const repository = receiver.typeId ? repositories.get(receiver.typeId) : undefined;
      if (repository?.entity) {
        const declared = declaredOf(repository.type).filter((item) => item.fn.properties.name === callee);
        const sameArity = declared.filter((item) => Number(item.fn.properties.parameterCount) === Number(call.properties.argumentCount));
        const chosen = sameArity.length > 0 ? sameArity : declared;
        if (chosen.length > 0) {
          // Reached through the call that resolves to the declared method; else straight from the caller.
          const resolved = resolvedCalls.get(call.id);
          if (chosen.some((item) => resolved?.has(item.fn.id))) continue;
          for (const access of chosen[0]!.accesses) accesses.push({ ...base, modelId: access.modelId, operation: access.operation });
          continue;
        }
        const operation = repository.crud ? CRUD[callee] : undefined;
        if (operation) accesses.push({ ...base, modelId: repository.entity.modelId, operation });
        continue;
      }

      const isEntityManager = receiverMatches(receiver, EM);
      const isSession = !isEntityManager && receiverMatches(receiver, SESSION);
      if (!isEntityManager && !isSession) continue;
      const args = callArgs.get(call.id) ?? [];
      const scope = types.byId.get(method.owner.id) ?? null;
      if (!scope) continue;
      if (callee === "createQuery" || callee === "createNativeQuery" || callee === "createSQLQuery") {
        const first = args[0];
        if (!first || !("s" in first)) continue;
        const text = stringOf(first.s, scope);
        if (!text) continue;
        const found = callee !== "createQuery" ? sqlModels(text) : jpqlAccesses(text, scope, null);
        for (const access of found) accesses.push({ ...base, modelId: access.modelId, operation: access.operation });
        continue;
      }
      const operation = (isEntityManager ? EM_OPERATIONS : SESSION_OPERATIONS)[callee];
      const first = args[0];
      if (!operation || !first) continue;
      let entity: Entity | null = null;
      const typeOfName = (name: string | null): Entity | null => {
        const target = name ? visibleType(name, scope) : null;
        return target ? entities.get(target.id) ?? null : null;
      };
      if ("c" in first) entity = typeOfName(normalizeJavaType(first.c));
      else if ("e" in first) {
        const written = receivers.typeOf(first.e, fn);
        entity = written?.typeId ? entities.get(written.typeId) ?? null : null;
      }
      if (entity) accesses.push({ ...base, modelId: entity.modelId, operation });
    }

    recordJavaDataAccesses(graph, accesses);
  },
};
