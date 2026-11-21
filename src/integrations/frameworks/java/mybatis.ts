import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { MAX_PARSED_BYTES } from "../../languages/plain/parser.js";
import { createJavaTypeIndex } from "../../languages/java/types.js";
import { annotationValue, findAnnotations, javaAnnotationReader } from "./annotations.js";
import { sqlModelAccesses, type JavaDataAccess } from "./data-shared.js";
import { mapperStatements, readMapperFile, type MapperFile } from "./mybatis-xml.js";
import { javaMethods } from "./shared.js";
import { createJavaStringResolver, javaStringFromText, javaStringLiteralValue } from "./strings.js";

// MyBatis mapper interfaces and mapper XML, as accesses of the mapper's methods (library `mybatis`).
//   - `@Select` / `@Insert` / `@Update` / `@Delete` (`org.apache.ibatis.annotations`) on an interface method: the
//     SQL (a literal, a text block, an array of literals joined by a space, `+` concatenation, constants) is
//     read by the SQL layer; the method is the access site (`functionId`), so callers of the mapper method
//     reach the tables through CALL_RESOLVES_TO as for any call;
//   - mapper XML (any `.xml` file with a `<mapper namespace="a.b.UserMapper">` root, see `mybatis-xml.ts`):
//     each `<select|insert|update|delete id="findById">` is linked to the method `findById` of the scanned
//     interface `a.b.UserMapper` (every overload of that name, declared in the interface or inherited from its
//     scanned super-interfaces; MyBatis allows one statement per name). A `<selectKey>` of a statement is read
//     as a `read` of its own, not as part of the statement's SQL. XML files over `MAX_PARSED_BYTES` and the
//     ones under a `target/` or `build/` directory are skipped.
// A mapper needs no `@Mapper`: an annotated statement or an XML namespace that names the interface makes it one.
// Not handled: `@SelectProvider` / `@InsertProvider` / `@UpdateProvider` / `@DeleteProvider` (the SQL is built
// by a method), `@MapperScan` (a mapper without annotated statements or XML has no SQL anyway),
// `@Lang`, `<script>` blocks inside annotations are read as text with their tags left in, XML statements of
// a namespace that names no scanned interface, `<include>` properties (`<property name>` substitution),
// `databaseId` variants (every variant is read), Kotlin and XML-less Groovy mappers.

const ANNOTATIONS = ["Select", "Insert", "Update", "Delete"];
const PACKAGES = ["org.apache.ibatis.annotations"];

const clean = (sql: string): string => sql.replace(/#\{[^}]*\}|\$\{[^}]*\}/gu, "?").replace(/\s+/gu, " ").trim();

export async function mybatisAccesses(graph: IGraphContributor, rootPath: string, files: readonly string[]): Promise<JavaDataAccess[]> {
  const interfaces = new Map<string, { id: string; fileId: string; methods: Array<{ id: string; name: string }> }>();
  for (const method of javaMethods(graph)) {
    if (method.owner.label !== "Interface" || method.owner.properties.kind === "annotation") continue;
    const qualified = String(method.owner.properties.qualifiedName ?? "");
    const entry = interfaces.get(qualified) ?? { id: method.owner.id, fileId: method.fileId, methods: [] };
    entry.methods.push({ id: method.node.id, name: String(method.node.properties.name) });
    interfaces.set(qualified, entry);
  }
  const accesses: JavaDataAccess[] = [];
  const record = (functionId: string, sql: string, line: number, expression: string, operation?: JavaDataAccess["operation"]): void => {
    for (const access of sqlModelAccesses(graph, clean(sql), "mybatis")) {
      accesses.push({ functionId, modelId: access.modelId, operation: operation ?? access.operation, library: "mybatis", line, expression });
    }
  };
  // The methods of an interface and of its scanned super-interfaces.
  const types = createJavaTypeIndex(graph, createResolutionRelationshipIndex(graph));
  const byOwner = new Map([...interfaces.values()].map((entry) => [entry.id, entry.methods]));
  const methodsOf = (ownerId: string, seen = new Set<string>()): Array<{ id: string; name: string }> => {
    if (seen.has(ownerId)) return [];
    seen.add(ownerId);
    const type = types.byId.get(ownerId);
    return [...byOwner.get(ownerId) ?? [], ...(type ? types.supertypes(type).filter((parent) => parent.isInterface).flatMap((parent) => methodsOf(parent.id, seen)) : [])];
  };

  // Annotations.
  const reader = javaAnnotationReader(graph);
  const strings = createJavaStringResolver(graph);
  const hasCandidateAnnotations = graph.nodesWithLabel("Decorator").some((node) => ANNOTATIONS.includes(String(node.properties.name ?? "").split(".").at(-1)!));
  if (hasCandidateAnnotations) {
    for (const method of javaMethods(graph)) {
      if (method.owner.label !== "Interface") continue;
      const list = reader.annotationsOf(method.node);
      for (const name of ANNOTATIONS) {
        for (const ann of findAnnotations(list, name, PACKAGES)) {
          const values = annotationValue(ann);
          if (!values || values.length === 0) continue;
          const scope = { fileId: method.fileId, typeId: method.owner.id };
          const parts: string[] = [];
          for (const value of values) {
            const text = value.resolved ? value.value : javaStringLiteralValue(value.value) ?? (() => {
              const template = javaStringFromText(value.value);
              return template ? strings.resolve(template, scope) : null;
            })();
            if (text !== null) parts.push(text);
          }
          if (parts.length === 0) continue;
          record(method.node.id, parts.join(" "), ann.line, `@${name}`);
        }
      }
    }
  }

  // Mapper XML.
  const mappers: Array<{ file: MapperFile; relative: string }> = [];
  for (const absolute of [...files].filter((file) => file.endsWith(".xml")).sort()) {
    const relative = path.relative(rootPath, absolute).split(path.sep).join("/");
    if (relative.split("/").slice(0, -1).some((segment) => segment === "target" || segment === "build")) continue;
    const info = await stat(absolute).catch(() => null);
    if (!info || info.size > MAX_PARSED_BYTES) continue;
    const source = await readFile(absolute, "utf8").catch(() => null);
    if (source === null) continue;
    const mapper = readMapperFile(source);
    if (mapper) mappers.push({ file: mapper, relative });
  }
  const resolved = mapperStatements(mappers.map((entry) => entry.file));
  resolved.forEach((mapper, index) => {
    const target = interfaces.get(mapper.namespace);
    if (!target) return;
    const base = path.posix.basename(mappers[index]!.relative);
    for (const statement of mapper.statements) {
      for (const method of methodsOf(target.id).filter((candidate) => candidate.name === statement.id)) {
        record(method.id, statement.sql, statement.line, `${base}#${statement.id}`);
        for (const key of statement.keySql) record(method.id, key, statement.line, `${base}#${statement.id}`, "read");
      }
    }
  });
  return accesses;
}
