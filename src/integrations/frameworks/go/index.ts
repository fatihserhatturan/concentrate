import { createGoParser } from "../../languages/go/parser.js";
import { goRoutesPlugin } from "./routes.js";
import { goEntrypointsPlugin } from "./entrypoints.js";
import { goEnvConfigPlugin } from "./env-config.js";
import { goDataAccessPlugin } from "./data-access.js";
import { goHttpClientsPlugin } from "./http-clients.js";

export { goRoutesContributor } from "./route-mounts.js";
export { goEntrypointsContributor } from "./entrypoints.js";
export { goEnvConfigContributor } from "./env-config.js";
export { goDataAccessContributor } from "./data-access.js";
export { goHttpClientsContributor } from "./http-clients.js";

// The Go parser with the framework layer's parse-time semantics.
export const goFrameworkParser = createGoParser([goRoutesPlugin, goEntrypointsPlugin, goEnvConfigPlugin, goDataAccessPlugin, goHttpClientsPlugin]);
