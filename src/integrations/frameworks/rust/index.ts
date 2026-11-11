import { createRustParser } from "../../languages/rust/parser.js";
import { rustRoutesPlugin } from "./routes.js";
import { rustEntrypointsPlugin } from "./entrypoints.js";
import { rustEnvConfigPlugin } from "./env-config.js";

export { rustRoutesContributor } from "./route-mounts.js";
export { rustEntrypointsContributor } from "./entrypoints.js";

// The Rust parser with the framework layer's parse-time semantics.
export const rustFrameworkParser = createRustParser([rustRoutesPlugin, rustEntrypointsPlugin, rustEnvConfigPlugin]);
