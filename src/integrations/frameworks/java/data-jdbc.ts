import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { JavaParsePlugin } from "../../languages/java/parser.js";

// Java JDBC and MyBatis (Phase 42, track B). Stub: registered, does nothing yet.
//
// The track implements:
//   - SQL strings given to `JdbcTemplate`, `NamedParameterJdbcTemplate`, `JdbcClient`, `SimpleJdbcInsert`,
//     `Connection.prepareStatement` / `prepareCall`, `Statement.execute*` and `PreparedStatement`: the
//     receiver's type from `receivers.ts`, the string (constants and concatenation) from `strings.ts`,
//     the tables of the statement from `sqlModelAccesses` in `data-shared.ts`;
//   - MyBatis: `@Select` / `@Insert` / `@Update` / `@Delete` on mapper interface methods, and mapper XML
//     statements (`<select id>`, `<insert>`, … in a `namespace` that names the mapper interface) linked to
//     the mapper methods they implement.
// Nodes and relationships are made only through `data-shared.ts` so the tables merge with JPA's and the
// SQL files'. The contributor runs before `js-ts.data-access` (it turns each access into READS / WRITES)
// and before `sql.schema`.
//
// Bump `version` of the plugin when its parse output changes.
export const javaDataJdbcPlugin: JavaParsePlugin & { version: string } = Object.assign<JavaParsePlugin, { version: string }>(() => {}, { version: "0" });

export const javaDataJdbcContributor: ISemanticContributor = {
  id: "java.data-jdbc",
  contribute() {},
};
