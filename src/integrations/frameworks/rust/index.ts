import { createRustParser } from "../../languages/rust/parser.js";
import { rustRoutesPlugin } from "./routes.js";

export { rustRoutesContributor } from "./route-mounts.js";

// The Rust parser with the framework layer's parse-time semantics.
export const rustFrameworkParser = createRustParser([rustRoutesPlugin]);
