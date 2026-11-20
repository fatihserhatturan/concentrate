import { createJavaParser } from "../../languages/java/parser.js";
import { javaGrpcPlugin } from "./grpc.js";
import { javaWebfluxPlugin } from "./webflux.js";
import { javaStringConstantsPlugin } from "./strings.js";
import { javaDataJpaPlugin } from "./data-jpa.js";
import { javaDataJdbcPlugin } from "./data-jdbc.js";
import { javaConfigEnvPlugin } from "./config-env.js";
import { javaHttpClientsPlugin } from "./http-clients.js";
export { javaEntrypointsContributor } from "./entrypoints.js";
export { javaTestsContributor } from "./tests.js";
export { javaBuildContributor } from "./build.js";
export { javaFrameworkEntrypointsContributor } from "./framework-entrypoints.js";
export { javaRoutesContributor } from "./routes.js";
export { javaDiContributor } from "./di.js";
export { javaWebfluxContributor, javaWebfluxPlugin } from "./webflux.js";
export { javaGrpcContributor, javaGrpcPlugin } from "./grpc.js";
export { javaDataJpaContributor, javaDataJpaPlugin } from "./data-jpa.js";
export { javaDataJdbcContributor, javaDataJdbcPlugin } from "./data-jdbc.js";
export { javaConfigEnvContributor, javaConfigEnvPlugin } from "./config-env.js";
export { javaHttpClientsContributor, javaHttpClientsPlugin } from "./http-clients.js";
export { javaStringConstantsPlugin } from "./strings.js";
// The string constants plugin goes first: the data, config and HTTP plugins may read what it keeps.
export const javaFrameworkParser = createJavaParser([
  javaStringConstantsPlugin,
  javaWebfluxPlugin,
  javaGrpcPlugin,
  javaDataJpaPlugin,
  javaDataJdbcPlugin,
  javaConfigEnvPlugin,
  javaHttpClientsPlugin,
]);
