import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { JavaParsePlugin } from "../../languages/java/parser.js";

// Java JPA / Hibernate and Spring Data (Phase 42, track A). Stub: registered, does nothing yet.
//
// The track implements:
//   - `@Entity` / `@MappedSuperclass` / `@Embeddable` classes as DataModel linked by MAPS_TO_TABLE to a Table
//     (`@Table(name, schema)`, else Spring's naming of the class; `@Column`, `@Id`, `@JoinColumn`,
//     `@OneToMany` … as the Table's `columns` and RELATES_TO between models);
//   - Spring Data repositories (`JpaRepository<T, ID>`, `CrudRepository`, `PagingAndSortingRepository`,
//     `Repository`, … ) linked to their entity; the inherited CRUD methods, derived query methods
//     (`findByEmailAndActive`) and `@Query` (JPQL against entity names, native SQL through
//     `sqlModelAccesses`) as accesses with an operation;
//   - `EntityManager` / `Session` calls (`persist`, `find`, `createQuery`, …) found through `receivers.ts`.
// Nodes and relationships are made only through `data-shared.ts` (`javaTable`, `javaDataModel`,
// `recordJavaDataAccesses`) so the tables merge with JDBC's and the SQL files'. The contributor runs
// before `js-ts.data-access` (it turns each access into READS / WRITES) and before `sql.schema`.
// Annotation arguments come from `annotations.ts`; string constants from `strings.ts`.
//
// Bump `version` of the plugin when its parse output changes.
export const javaDataJpaPlugin: JavaParsePlugin & { version: string } = Object.assign<JavaParsePlugin, { version: string }>(() => {}, { version: "0" });

export const javaDataJpaContributor: ISemanticContributor = {
  id: "java.data-jpa",
  contribute() {},
};
