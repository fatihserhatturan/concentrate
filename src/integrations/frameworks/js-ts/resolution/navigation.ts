import { readFile } from "node:fs/promises";
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
//
// Links in markup are linked from the File: `<Link href="/x">`,
// `<Link to="/x">`, `<NavLink>`, `<Navigate to>`, `<NuxtLink to>`,
// `<router-link to>`, `<a href="/x">` in JSX, Vue, Svelte, Astro and HTML, and
// `routerLink="/x"` (or `[routerLink]="['/x']"`, a one-element array) on any
// element of an Angular template, with a literal path. The File's NAVIGATES_TO
// has the `line` of the tag. A bound value that is not a plain literal
// (`:to="{ name: 'x' }"`, `to={`/u/${id}`}`) is not linked.

const FREE_CALLS = new Set(["navigate", "redirect", "permanentRedirect", "goto", "navigateTo", "navigateByUrl"]);
const ROUTER_CALLS = new Set(["push", "replace", "navigate", "navigateByUrl", "redirect"]);
const ROUTER_RECEIVER = /(?:^|\.)\$?(?:router|Router|history|navigation|navigator)$/u;
const DESTINATION_KINDS = new Set(["page", undefined, null]);

type PageEntry = { id: string; segments: RouteSegment[] };

export const navigationContributor: ISemanticContributor = {
  async contribute(graph) {
    const pages: PageEntry[] = [];
    for (const node of graph.nodes) {
      if (node.label !== "Page" || typeof node.properties.fullPath !== "string") continue;
      if (!DESTINATION_KINDS.has(node.properties.kind as string | undefined)) continue;
      pages.push({ id: node.id, segments: routeSegments(node.properties.fullPath) });
    }
    if (pages.length === 0) return;

    // The one page a path reaches: literal segments over parameters over catch-alls; a tie reaches none.
    const pageFor = (url: string) => {
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
      return best && tied === 1 ? best : null;
    };

    const added: GraphRelationship[] = [];
    for (const call of graph.nodes) {
      if (call.label !== "Call") continue;
      const url = navigationTarget(call);
      const target = url === null ? null : pageFor(url);
      if (target) added.push({ from: call.id, to: target.page.id, type: "NAVIGATES_TO", properties: { url: url!, match: target.match } });
    }

    // Files with markup: every markup file, and the files that declare components (JSX, Angular inline templates).
    const withComponents = new Set(graph.relationships.filter((relationship) => relationship.type === "DECLARES_COMPONENT").map((relationship) => relationship.from));
    for (const file of graph.nodes) {
      if (file.label !== "File" || typeof file.properties.path !== "string") continue;
      if (!MARKUP_FILE.test(file.properties.path) && !withComponents.has(file.id)) continue;
      const text = await readFile(file.properties.path, "utf8").catch(() => null);
      if (text === null || !MAYBE_LINK.test(text)) continue;
      for (const link of markupLinks(text)) {
        const target = pageFor(link.url);
        if (target) added.push({ from: file.id, to: target.page.id, type: "NAVIGATES_TO", properties: { url: link.url, match: target.match, line: link.line } });
      }
    }
    for (const relationship of added) graph.addRelationship(relationship);
  },
};

const MARKUP_FILE = /\.(?:jsx|tsx|vue|svelte|astro|html?)$/u;
const MAYBE_LINK = /\b(?:href|to|routerLink)\b/u;
const LINK_TAGS = new Set(["a", "Link", "NavLink", "Navigate", "NuxtLink", "nuxt-link", "RouterLink", "router-link"]);

export type MarkupLink = { url: string; line: number };

// Literal internal paths that links in markup name. Tags are read with their
// attributes up to the closing `>` (quotes and braces respected).
export function markupLinks(text: string): MarkupLink[] {
  const links: MarkupLink[] = [];
  const open = /<([A-Za-z][\w.:-]*)/gu;
  for (let tag = open.exec(text); tag; tag = open.exec(text)) {
    const start = tag.index + tag[0].length;
    let end = start;
    let quote: string | null = null;
    let depth = 0;
    for (; end < text.length; end += 1) {
      const char = text[end]!;
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || (char === "`" && depth > 0)) quote = char;
      else if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      else if (char === ">" && depth <= 0) break;
      else if (char === "<" && depth <= 0) break;
    }
    const attributes = text.slice(start, end);
    const line = text.slice(0, tag.index).split("\n").length;
    const name = tag[1]!;
    const attribute = /(?:^|\s)(?::|v-bind:|\[)?(href|to|routerLink)\]?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(["'`])([^"'`$\\]*)\4\s*\})/gu;
    for (let found = attribute.exec(attributes); found; found = attribute.exec(attributes)) {
      const [whole, attributeName, double, single, , braced] = found;
      if (attributeName !== "routerLink" && !LINK_TAGS.has(name)) continue;
      if (attributeName === "to" && name === "a") continue;
      const bound = /^\s*(?::|v-bind:|\[)/u.test(whole!);
      let value = braced ?? double ?? single ?? "";
      if (bound && braced === undefined) {
        // `:to="'/x'"` and `[routerLink]="'/x'"` or `"['/x']"`: a quoted literal, or an array of one.
        const literal = /^\s*(?:\[\s*)?(["'`])([^"'`$\\]*)\1\s*\]?\s*$/u.exec(value);
        if (!literal) continue;
        value = literal[2]!;
      }
      if (!value.startsWith("/") || value.startsWith("//") || value.includes("${")) continue;
      links.push({ url: value.split(/[?#]/u)[0]!, line });
    }
    open.lastIndex = Math.max(open.lastIndex, tag.index + tag[0].length);
  }
  return links;
}

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
