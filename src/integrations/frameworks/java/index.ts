import { createJavaParser } from "../../languages/java/parser.js";
import { javaGrpcPlugin } from "./grpc.js";
import { javaWebfluxPlugin } from "./webflux.js";
export { javaEntrypointsContributor } from "./entrypoints.js";
export { javaTestsContributor } from "./tests.js";
export { javaBuildContributor } from "./build.js";
export { javaWebfluxContributor, javaWebfluxPlugin } from "./webflux.js";
export { javaGrpcContributor, javaGrpcPlugin } from "./grpc.js";
export const javaFrameworkParser = createJavaParser([javaWebfluxPlugin, javaGrpcPlugin]);
