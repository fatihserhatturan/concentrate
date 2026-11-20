import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { JavaParsePlugin } from "../../languages/java/parser.js";

// Java outbound HTTP (Phase 42, track D). Stub: registered, does nothing yet.
//
// The track implements:
//   - calls of `RestTemplate`, `RestClient`, `WebClient`, `java.net.http.HttpClient` (`HttpRequest.newBuilder`),
//     OkHttp (`Request.Builder`) and Apache `HttpClient`, found through the receiver's type
//     (`receivers.ts`), with the method and the URL (`strings.ts`: literals, constants, `${expression}`
//     placeholders; base URLs from `@Value("${api.url}")` fields through `readSpringConfig` in
//     `config-files.ts`) as `httpMethod` / `httpUrl` properties on the Call node, the way the Go and
//     Python clients record them;
//   - OpenFeign `@FeignClient(name, url, path)` interfaces: each method with `@GetMapping` …
//     a request with the base URL and path.
// `js-ts.http-requests` then links each such Call to the Route it reaches (REQUESTS), so this contributor
// runs before it.
//
// Bump `version` of the plugin when its parse output changes.
export const javaHttpClientsPlugin: JavaParsePlugin & { version: string } = Object.assign<JavaParsePlugin, { version: string }>(() => {}, { version: "0" });

export const javaHttpClientsContributor: ISemanticContributor = {
  id: "java.http-clients",
  contribute() {},
};
