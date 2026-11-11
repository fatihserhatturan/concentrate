import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode } from "../src/core/graph/model.js";
import { literalClassNames } from "../src/integrations/frameworks/styles/class-refs.js";
import { withSyntaxTree } from "../src/integrations/languages/syntax/tree-sitter.js";

async function classNames(expression: string, objects = false): Promise<string[]> {
  return withSyntaxTree("javascript", `(${expression})`, (tree) => literalClassNames(tree.rootNode.namedChildren[0]?.namedChildren[0], objects));
}

describe("literal class names", () => {
  it("reads strings, static templates, branches and class-name helpers, not computed names", async () => {
    assert.deepEqual(await classNames("'a  b'"), ["a", "b"]);
    assert.deepEqual(await classNames("`a ${x} b c-${y}`"), ["a", "b"]);
    assert.deepEqual(await classNames("on ? 'a' : 'b'"), ["a", "b"]);
    assert.deepEqual(await classNames("on && 'a'"), ["a"]);
    assert.deepEqual(await classNames("clsx('a', on && 'b', { c: x, 'd-e': y }, [ 'f' ])"), ["a", "b", "c", "d-e", "f"]);
    assert.deepEqual(await classNames("{ a: 1 }"), []);
    assert.deepEqual(await classNames("{ a: 1, shorthand }", true), ["a", "shorthand"]);
    assert.deepEqual(await classNames("compute('a')"), []);
  });
});

describe("class links in the graph", () => {
  let graph: Awaited<ReturnType<typeof buildCodeGraph>>;
  let byId: Map<string, GraphNode>;
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/styles-links"), { continueOnError: false });
    byId = new Map(graph.nodes.map((node) => [node.id, node]));
  });
  const file = (id: string): string => {
    const own = byId.get(id)!;
    if (own.label === "File") return String(own.properties.relativePath);
    const declared = graph.relationships.find((rel) => (rel.type === "DECLARES_STYLE" || rel.type === "DECLARES_COMPONENT") && rel.to === id);
    return declared ? file(declared.from) : "?";
  };
  const label = (id: string): string => {
    const node = byId.get(id)!;
    return node.label === "File" ? `file ${file(id)}` : `${node.label} ${node.properties.name}`;
  };
  const links = (prefix: string) => graph.relationships
    .filter((rel) => rel.type === "USES_STYLE" && file(rel.from).startsWith(prefix) && byId.get(rel.to)?.properties.kind === "class")
    .map((rel) => `${label(rel.from)} -> ${byId.get(rel.to)!.properties.name}@${file(rel.to).replace(/^src\//u, "")} [${rel.properties.match}] ${rel.properties.expression}`)
    .sort();

  it("links CSS Modules and $style members to the class of that file, exactly", () => {
    const exact = (prefix: string) => links(prefix).filter((entry) => entry.includes("[module]"));
    assert.deepEqual(exact("src/react/"), [
      "Component Button -> btn@react/Button.module.css [module] styles.btn",
      "Component Button -> icon@react/Button.module.css [module] styles.icon",
      "Component Button -> primary@react/Button.module.css [module] styles[\"primary\"]",
    ]);
    assert.deepEqual(exact("src/vue/"), [
      "Component Panel -> body@vue/Panel.vue [module] $style[\"body\"]",
      "Component Panel -> header@vue/Panel.vue [module] $style.header",
    ]);
    // styles.unknown names no class of the module, so nothing is linked.
    assert.ok(!links("src/react/").some((entry) => entry.includes("unknown")));
  });

  it("links literal class names in JSX, preferring sheets the file imports", () => {
    assert.deepEqual(links("src/react/").filter((entry) => !entry.includes("[module]")), [
      "Component Button -> legacy-btn@react/Button.module.css [import] className",
      "Component Button -> loading@react/card.css [name] className",
      "Component Card -> card@react/card.css [import] className",
      "Component Card -> note@react/global.css [name] className",
      "Component Card -> note@public/site.css [name] className",
      "Component Card -> open@angular/nav.css [name] className",
      "Component Card -> open@react/global.css [name] className",
      "Component Card -> title@react/card.css [import] className",
    ].sort());
  });

  it("links class attributes of Vue, Svelte and Astro to their own <style> blocks", () => {
    assert.deepEqual(links("src/vue/").filter((entry) => !entry.includes("[module]")), [
      "Component Panel -> on@vue/Panel.vue [import] :class",
      "Component Panel -> panel@vue/Panel.vue [import] class",
      "Component Panel -> shared@vue/Panel.vue [import] class",
      "Component Panel -> wide@vue/Panel.vue [import] class",
    ]);
    assert.deepEqual(links("src/svelte/"), [
      "Component Tab -> big@svelte/Tab.svelte [import] class",
      "Component Tab -> selected@svelte/Tab.svelte [import] class:",
      "Component Tab -> tab@svelte/Tab.svelte [import] class",
    ]);
    assert.deepEqual(links("src/astro/"), [
      "Component Hero -> hero@astro/Hero.astro [import] class",
      "Component Hero -> wide@astro/Hero.astro [import] class:list",
    ]);
  });

  it("reads Angular inline templates for their component and templateUrl files for theirs", () => {
    assert.deepEqual(links("src/angular/app.component.ts"), [
      "Component AppComponent -> nav@angular/nav.css [name] class",
      "Component AppComponent -> open@angular/nav.css [name] [ngClass]",
      "Component AppComponent -> open@react/global.css [name] [ngClass]",
      "Component AppComponent -> sticky@angular/nav.css [name] [class.]",
    ]);
    assert.deepEqual(links("src/angular/list.component.ts"), [
      "Component ListComponent -> list@angular/nav.css [name] class",
      "Component ListComponent -> striped@angular/nav.css [name] [ngClass]",
    ]);
  });

  it("links an HTML page's classes, through its <link> sheet first", () => {
    assert.deepEqual(links("public/index.html"), [
      "file public/index.html -> note@public/site.css [import] class",
      "file public/index.html -> open@angular/nav.css [name] class",
      "file public/index.html -> open@react/global.css [name] class",
      "file public/index.html -> page@public/site.css [import] class",
    ].sort());
  });

  it("leaves no transient data on the files", () => {
    assert.ok(graph.nodes.every((node) => node.properties.styleRefs === undefined && node.properties.styleVarUses === undefined));
  });
});
