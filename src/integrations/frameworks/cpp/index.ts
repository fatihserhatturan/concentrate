import { createCppParser } from "../../languages/cpp/parser.js";
import { cppRoutesPlugin } from "./routes.js";
import { cppEnvConfigPlugin } from "./env-config.js";
import { cppDataAccessPlugin } from "./data-access.js";
import { cppHttpClientsPlugin } from "./http-clients.js";
import { cppGrpcPlugin } from "./grpc.js";
import { cppQtPlugin } from "./qt.js";

export { cppBuildContributor } from "./build.js";
export { cppRoutesContributor } from "./routes.js";
export { cppEnvConfigContributor } from "./env-config.js";
export { cppDataAccessContributor } from "./data-access.js";
export { cppGrpcContributor } from "./grpc.js";
export { cppQtContributor } from "./qt.js";

// The C and C++ parsers with the framework layer's parse-time semantics (the
// routes plugin first: data access reads the lambda handlers it records).
const plugins = [cppRoutesPlugin, cppEnvConfigPlugin, cppDataAccessPlugin, cppHttpClientsPlugin, cppGrpcPlugin, cppQtPlugin];
export const cFrameworkParser = createCppParser("c", plugins);
export const cppFrameworkParser = createCppParser("cpp", plugins);
