import { createCSharpParser } from "../../languages/csharp/parser.js";
import { csharpRoutesPlugin, csharpRoutesSchema } from "./routes.js";
import { csharpGrpcPlugin, csharpGrpcSchema } from "./grpc.js";
import { csharpSignalrPlugin, csharpSignalrSchema } from "./signalr.js";
import { csharpFrameworkEntrypointsPlugin, csharpFrameworkEntrypointsSchema } from "./framework-entrypoints.js";
import { csharpDiPlugin, csharpDiSchema } from "./di.js";
import { csharpStringConstantsPlugin } from "./strings.js";
import { csharpDataEfcorePlugin, csharpDataEfcoreSchema } from "./data-efcore.js";
import { csharpDataSqlPlugin, csharpDataSqlSchema } from "./data-sql.js";
import { csharpConfigEnvPlugin, csharpConfigEnvSchema } from "./config-env.js";
import { csharpHttpClientsPlugin, csharpHttpClientsSchema } from "./http-clients.js";
export { csharpEntrypointsContributor } from "./entrypoints.js";
export { csharpTestsContributor } from "./tests.js";
export { csharpProjectsContributor } from "./projects.js";
export { csharpRoutesContributor, csharpRoutesPlugin, csharpRoutesSchema } from "./routes.js";
export { csharpGrpcContributor, csharpGrpcPlugin, csharpGrpcSchema } from "./grpc.js";
export { csharpSignalrContributor, csharpSignalrPlugin, csharpSignalrSchema } from "./signalr.js";
export { csharpFrameworkEntrypointsContributor, csharpFrameworkEntrypointsPlugin, csharpFrameworkEntrypointsSchema } from "./framework-entrypoints.js";
export { csharpHandlerInjectionContributor } from "./handler-injection.js";
export { csharpDiContributor, csharpDiPlugin, csharpDiSchema } from "./di.js";
export { csharpStringConstantsPlugin, csharpStringsContributor } from "./strings.js";
export { csharpDataEfcoreContributor, csharpDataEfcorePlugin, csharpDataEfcoreSchema } from "./data-efcore.js";
export { csharpDataSqlContributor, csharpDataSqlPlugin, csharpDataSqlSchema } from "./data-sql.js";
export { csharpConfigEnvContributor, csharpConfigEnvPlugin, csharpConfigEnvSchema } from "./config-env.js";
export { csharpHttpClientsContributor, csharpHttpClientsPlugin, csharpHttpClientsSchema } from "./http-clients.js";

// Each track adds its own plugin (and keeps its own schema extension) in its own file; this list only wires them.
// The string constants plugin goes first (Phase 47): the data, config and HTTP plugins may read what it keeps.
export const csharpFrameworkParser = createCSharpParser([
  csharpStringConstantsPlugin,
  csharpRoutesPlugin,
  csharpGrpcPlugin,
  csharpSignalrPlugin,
  csharpFrameworkEntrypointsPlugin,
  csharpDiPlugin,
  csharpDataEfcorePlugin,
  csharpDataSqlPlugin,
  csharpConfigEnvPlugin,
  csharpHttpClientsPlugin,
]);

export const csharpFrameworkSchemas = [csharpRoutesSchema, csharpGrpcSchema, csharpSignalrSchema, csharpFrameworkEntrypointsSchema, csharpDiSchema, csharpDataEfcoreSchema, csharpDataSqlSchema, csharpConfigEnvSchema, csharpHttpClientsSchema] as const;
