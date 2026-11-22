import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphSchemaExtension } from "../../../core/graph/schema.js";
import type { VersionedCSharpParsePlugin } from "../../languages/csharp/parser.js";

// WAVE 0 STUB (Track B): SignalR hubs (`Hub` / `Hub<T>` public methods, `MapHub<T>`).
// Fill in the bodies below (see the phase 46 contract). A no-op until then.

// Parse-time part (what only the syntax tree tells). Set `version` (a string, e.g. "1") when it starts producing output:
// it joins the parser's cache fingerprint.
export const csharpSignalrPlugin: VersionedCSharpParsePlugin = () => {};

export const csharpSignalrContributor: ISemanticContributor = {
  id: "csharp.signalr",
  contribute() {},
};

// Graph schema additions of this track (new properties or tables its output needs). Registered in default-registry
// through csharp/index.ts; leave as is when the output uses existing properties only.
export const csharpSignalrSchema: GraphSchemaExtension = { id: "csharp-signalr" };
