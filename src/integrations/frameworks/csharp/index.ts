import { createCSharpParser } from "../../languages/csharp/parser.js";
import { csharpRoutesPlugin, csharpRoutesSchema } from "./routes.js";
import { csharpGrpcPlugin, csharpGrpcSchema } from "./grpc.js";
import { csharpSignalrPlugin, csharpSignalrSchema } from "./signalr.js";
import { csharpFrameworkEntrypointsPlugin, csharpFrameworkEntrypointsSchema } from "./framework-entrypoints.js";
import { csharpDiPlugin, csharpDiSchema } from "./di.js";
export { csharpEntrypointsContributor } from "./entrypoints.js";
export { csharpTestsContributor } from "./tests.js";
export { csharpProjectsContributor } from "./projects.js";
export { csharpRoutesContributor, csharpRoutesPlugin, csharpRoutesSchema } from "./routes.js";
export { csharpGrpcContributor, csharpGrpcPlugin, csharpGrpcSchema } from "./grpc.js";
export { csharpSignalrContributor, csharpSignalrPlugin, csharpSignalrSchema } from "./signalr.js";
export { csharpFrameworkEntrypointsContributor, csharpFrameworkEntrypointsPlugin, csharpFrameworkEntrypointsSchema } from "./framework-entrypoints.js";
export { csharpDiContributor, csharpDiPlugin, csharpDiSchema } from "./di.js";

// Each Phase 46 track adds its own plugin (and keeps its own schema extension) in its own file; this list only wires them.
export const csharpFrameworkParser = createCSharpParser([
  csharpRoutesPlugin,
  csharpGrpcPlugin,
  csharpSignalrPlugin,
  csharpFrameworkEntrypointsPlugin,
  csharpDiPlugin,
]);

export const csharpFrameworkSchemas = [csharpRoutesSchema, csharpGrpcSchema, csharpSignalrSchema, csharpFrameworkEntrypointsSchema, csharpDiSchema] as const;
