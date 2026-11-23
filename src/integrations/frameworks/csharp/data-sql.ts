import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphSchemaExtension } from "../../../core/graph/schema.js";
import type { VersionedCSharpParsePlugin } from "../../languages/csharp/parser.js";

// WAVE 0 STUB (Phase 47, Track B): Dapper and ADO.NET SQL strings (Query<T>, QueryAsync, Execute, SqlCommand, NpgsqlCommand, MySqlCommand).
// Fill in the bodies below (see the phase 47 contract). A no-op until then. This file, and the tests and fixtures of the
// track, are the only files the track edits.

// Parse-time part (what only the syntax tree tells: the argument expressions of a call, lambda bodies, ...). Keep what
// the contributor needs as a PRIVATE property on the Call / Field / Function node and remove it in the contributor (a
// private property must never reach the graph: the goldens would show it). Set `version` (a string, e.g. "1") when it
// starts producing output: it joins the parser's cache fingerprint.
export const csharpDataSqlPlugin: VersionedCSharpParsePlugin = () => {};

export const csharpDataSqlContributor: ISemanticContributor = {
  id: "csharp.data-sql",
  contribute() {},
};

// Graph schema additions of this track (new properties or tables its output needs). Registered in default-registry
// through csharp/index.ts; leave as is when the output uses existing properties only.
export const csharpDataSqlSchema: GraphSchemaExtension = { id: "csharp-data-sql" };
