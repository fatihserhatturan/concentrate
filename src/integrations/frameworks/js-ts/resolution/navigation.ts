import type { GraphNode, GraphRelationship } from "../../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../../core/contracts/semantic-contributor.js";
import { decodeSegment, matchSegments, routeSegments, type RouteSegment } from "./http-requests.js";

// NAVIGATES_TO: a call that sends the user to a path (`router.push("/login")`,
// `navigate("/cart")`, `redirect("/home")`, `goto("/x")`, `navigateTo("/x")`,
// `router.navigateByUrl("/x")`) to the Page that path reaches, so the
// function that navigates is linked to the screen it names. Only a literal
// path counts, as the first or second argument (`redirect(302, "/x")`);
// query strings and hashes are dropped. `push` and `replace` need a router-like
// receiver (`router`, `$router`, `Router`, `history`), so `list.push("/x")` is
// not a navigation. A path is matched like a request URL: literal segments over
// parameters over catch-alls, a tie between pages leaves the call unlinked.
// `match` is `exact`, `parameter` or `catch-all`. Layouts, loading and error
// files are not destinations.

const FREE_CALLS = new Set(["navigate", "redirect", "permanentRedirect", "goto", "navigateTo", "navigateByUrl"]);
const ROUTER_CALLS = new Set(["push", "replace", "navigate", "navigateByUrl", "redirect"]);
const ROUTER_RECEIVER = /(?:^|\.)\$?(?:router|Router|history|navigation|navigator)$/u;
const DESTINATION_KINDS = new Set(["page", undefined, null]);

type PageEntry = { id: string; segments: RouteSegment[] };

export const navigationContributor: ISemanticContributor = {
  contribute(graph) {
    const pages: PageEntry[] = [];
    for (const node of graph.nodes) {
      if (node.label !== "Page" || typeof node.properties.fullPath !== "string") continue;
      if (!DESTINATION_KINDS.has(node.properties.kind as string | undefined)) continue;
      pages.push({ id: node.id, segments: routeSegments(node.properties.fullPath) });
    }
    if (pages.length === 0) return;

    const added: GraphRelationship[] = [];
    for (const call of graph.nodes) {
      if (call.label !== "Call") continue;
      const url = navigationTarget(call);
      if (url === null) continue;
      const segments = url.split("/").filter(Boolean).map(decodeSegment);
      let best: { page: PageEntry; score: number; match: string } | null = null;
      let tied = 0;
      for (const page of pages) {
        const matched = matchSegments(segments, page.segments);
        if (!matched) continue;
        if (!best || matched.score > best.score) {
          best = { page, ...matched };
          tied = 1;
        } else if (matched.score === best.score) {
          tied += 1;
        }
      }
      if (best && tied === 1) added.push({ from: call.id, to: best.page.id, type: "NAVIGATES_TO", properties: { url, match: best.match } });
    }
    for (const relationship of added) graph.addRelationship(relationship);
  },
};

// The literal path a navigation call names, or null when the call is not one.
function navigationTarget(call: GraphNode): string | null {
  const callee = call.properties.callee;
  if (typeof callee !== "string") return null;
  const receiver = call.properties.receiver;
  const receiverName = typeof receiver === "string" ? receiver : null;
  const navigates = receiverName === null ? FREE_CALLS.has(callee) : ROUTER_CALLS.has(callee) && ROUTER_RECEIVER.test(receiverName);
  if (!navigates || typeof call.properties.args !== "string") return null;
  let args: unknown;
  try {
    args = JSON.parse(call.properties.args);
  } catch {
    return null;
  }
  if (!Array.isArray(args)) return null;
  const path = args.slice(0, 2).find((arg): arg is string => typeof arg === "string" && arg.startsWith("/") && !arg.startsWith("//"));
  return path === undefined ? null : path.split(/[?#]/u)[0]!;
}
