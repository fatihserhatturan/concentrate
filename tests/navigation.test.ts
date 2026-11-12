import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { scanIntoStore } from "../src/adapters/cli/scan.js";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { markupLinks } from "../src/integrations/frameworks/js-ts/resolution/navigation.js";
import { provenanceOf } from "../src/adapters/store/provenance.js";
import { openGraphStore } from "../src/composition/graph-store.js";

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "nav-app", dependencies: { next: "14.0.0", react: "18.0.0" } }),
  "app/page.tsx": "export default function Home() { return <main>home</main>; }\n",
  "app/login/page.tsx": "export default function Login() { return <main>login</main>; }\n",
  "app/users/[id]/page.tsx": "export default function User() { return <main>user</main>; }\n",
  "src/Menu.tsx": [
    "import Link from 'next/link';",
    "export function Menu({ id }: { id: string }) {",
    "  return (",
    "    <nav>",
    "      <Link href=\"/login\">Login</Link>",
    "      <Link href={\"/users/42\"} prefetch>Me</Link>",
    "      <Link href={`/users/${id}`}>Dynamic</Link>",
    "      <a href=\"https://example.com/login\">External</a>",
    "      <a href=\"/nowhere\">Nowhere</a>",
    "    </nav>",
    "  );",
    "}",
    "",
  ].join("\n"),
  "src/actions.ts": [
    "import { redirect } from 'next/navigation';",
    "export function afterLogout(router: any, list: string[]) {",
    "  router.push('/login?next=/cart');",
    "  router.replace('/users/42');",
    "  list.push('/login');",
    "  router.push('/nowhere');",
    "}",
    "export function guard() {",
    "  redirect('/');",
    "}",
    "",
  ].join("\n"),
};

describe("markup links", () => {
  it("reads literal internal paths from tags of JSX, Vue, Svelte and Angular templates", () => {
    const links = (text: string) => markupLinks(text).map((link) => [link.url, link.line]);
    assert.deepEqual(links('<Link href="/a">x</Link>\n<NavLink to=\'/b?x=1#y\'/>\n<Navigate to={"/c"} replace />'), [["/a", 1], ["/b", 2], ["/c", 3]]);
    assert.deepEqual(links('<router-link to="/v">x</router-link> <NuxtLink :to="\'/n\'">n</NuxtLink> <RouterLink :to="{ name: \'x\' }">x</RouterLink>'), [["/v", 1], ["/n", 1]]);
    assert.deepEqual(links('<a routerLink="/ng">x</a>\n<li [routerLink]="[\'/one\']"></li>\n<a [routerLink]="[\'/users\', id]">u</a>'), [["/ng", 1], ["/one", 2]]);
    assert.deepEqual(links('<a href="/s">s</a> <a href="//cdn.example.com">c</a> <a href="https://x.dev">e</a> <a href={`/t/${id}`}>t</a> <div href="/d"></div> <a to="/z">z</a>'), [["/s", 1]]);
    assert.deepEqual(links("const x = a < b && c > d;"), []);
  });
});

describe("navigation edges", () => {
  it("links navigation calls with a literal path to the page they reach", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-nav-"));
    const project = path.join(root, "project");
    for (const [file, text] of Object.entries(FILES)) {
      await mkdir(path.dirname(path.join(project, file)), { recursive: true });
      await writeFile(path.join(project, file), text);
    }
    const database = path.join(root, "graph");
    await scanIntoStore(project, { database, continueOnError: false, include: [], exclude: [], retryLock: true, cacheDir: path.join(root, "cache"), manifest: path.join(root, "m.json") });
    const store = await openGraphStore(database);
    try {
      const rows = await store.query(`
        MATCH (call:Call)-[nav:NAVIGATES_TO]->(page:Page)
        RETURN call.expression AS call, page.fullPath AS page, nav.match AS match, nav.provenance AS provenance
        ORDER BY call.line
      `) as Array<Record<string, string>>;
      assert.deepEqual(rows.map((row) => [row.call, row.page, row.match]), [
        ["router.push", "/login", "exact"],
        ["router.replace", "/users/[id]", "parameter"],
        ["redirect", "/", "exact"],
      ]);
      assert.ok(rows.every((row) => row.provenance === "exact"));

      const { pages } = (await callMcpTool(store, "list_pages", {})).structuredContent as any;
      const login = pages.find((page: any) => page.fullPath === "/login");
      assert.deepEqual(login.navigatedFrom.filter((entry: any) => !entry.markup).map((entry: any) => [entry.function, entry.file, entry.url]), [["afterLogout", "src/actions.ts", "/login"]]);
      const home = pages.find((page: any) => page.fullPath === "/");
      assert.equal(home.navigatedFrom[0].function, "guard");
      assert.equal(pages.find((page: any) => page.fullPath === "/users/[id]").navigatedFrom[0].match, "parameter");
      // Links in markup come from the file, with the tag's line and the one component the file declares.
      assert.deepEqual(login.navigatedFrom.filter((entry: any) => entry.markup).map((entry: any) => [entry.component, entry.file, entry.line, entry.url]), [["Menu", "src/Menu.tsx", 5, "/login"]]);
      const user = pages.find((page: any) => page.fullPath === "/users/[id]");
      assert.deepEqual(user.navigatedFrom.filter((entry: any) => entry.markup).map((entry: any) => [entry.line, entry.url]), [[6, "/users/42"]]);
    } finally {
      await store.close();
    }
  });

  it("calls a catch-all destination inferred", () => {
    assert.equal(provenanceOf({ type: "NAVIGATES_TO", properties: { match: "catch-all" } }), "inferred");
    assert.equal(provenanceOf({ type: "NAVIGATES_TO", properties: { match: "parameter" } }), "exact");
  });
});
