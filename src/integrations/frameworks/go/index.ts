import { createGoParser } from "../../languages/go/parser.js";
import { goRoutesPlugin } from "./routes.js";
import { goEntrypointsPlugin } from "./entrypoints.js";

export { goRoutesContributor } from "./route-mounts.js";
export { goEntrypointsContributor } from "./entrypoints.js";

// The Go parser with the framework layer's parse-time semantics.
export const goFrameworkParser = createGoParser([goRoutesPlugin, goEntrypointsPlugin]);
