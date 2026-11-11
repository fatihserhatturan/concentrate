import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode } from "../src/core/graph/model.js";
import { readStyles, selectorNames } from "../src/integrations/languages/plain/styles.js";

describe("style reader", () => {
  it("reads classes and ids of selectors, not of comments, strings or values", () => {
    const reading = readStyles("/* .c { } */ .a, .b:hover > #i::before { content: \".s\"; color: #fff; }\n@media (min-width: 1px) { .m { margin: .5em } }", "css");
    assert.deepEqual([...reading.classes.keys()], ["a", "b", "m"]);
    assert.deepEqual([...reading.ids.keys()], ["i"]);
    assert.deepEqual(reading.rules.map((rule) => [rule.selector, rule.line, rule.atRule]), [[".a, .b:hover > #i::before", 1, null], [".m", 2, "@media (min-width: 1px)"]]);
  });

  it("expands & in nested SCSS rules and drops names built at compile time", () => {
    const reading = readStyles(".a { &__b { .c & { x: y } } &.d { } .e { } .f-#{$x} { } @mixin m { &-z { } } }", "scss");
    assert.deepEqual([...reading.classes.keys()].sort(), ["a", "a__b", "c", "d", "e"]);
  });

  it("skips keyframe steps and font-face blocks", () => {
    const reading = readStyles("@keyframes k { from { a: b } 50% { c: d } } @font-face { src: url(a.woff) } .x { }", "css");
    assert.deepEqual(reading.rules.map((rule) => rule.selector), [".x"]);
  });

  it("reads custom property definitions and var() uses with lines", () => {
    const reading = readStyles(":root { --a: 1; --b: var(--a, 2) }\n.x { color: var( --b ); w: calc(var(--a) * 2) }\n@property --c { inherits: true }", "css");
    assert.deepEqual([...reading.definitions.values()].map((entry) => [entry.name, entry.line]), [["--a", 1], ["--b", 1], ["--c", 3]]);
    assert.deepEqual(reading.varUses.map((use) => [use.name, use.line]), [["--a", 1], ["--b", 2], ["--a", 2]]);
  });

  it("reads @import, @use, @forward, url() and composes; skips URLs, data URIs, packages and built-ins", () => {
    const reading = readStyles([
      "@import \"a.css\", url(b.css) screen;",
      "@import url(https://x.test/c.css);",
      "@use \"sass:math\"; @use \"./v\" as v with ($k: \"nope.css\"); @forward \"w\";",
      ".x { background: url(i.png), url(\"j.svg#f\"), url(data:image/png;base64,AAA=), url(/root.png), url(#g); composes: k from \"./k.module.css\"; composes: g from global; }",
    ].join("\n"), "scss");
    assert.deepEqual(reading.imports.map((entry) => [entry.kind, entry.source, entry.alias]), [
      ["import", "a.css", null],
      ["import", "./b.css", null],
      ["use", "./v", "v"],
      ["forward", "w", null],
      ["url", "./i.png", null],
      ["url", "./j.svg", null],
      ["composes", "./k.module.css", null],
    ]);
    const css = readStyles("@import \"a.css\"; @import \"./b\";", "css");
    assert.deepEqual(css.imports.map((entry) => entry.source), ["a.css", "./b"]);
  });

  it("treats :global() and :local() in CSS Modules", () => {
    assert.deepEqual(selectorNames(":global(.g) .l").classes, [{ name: "g", global: true }, { name: "l", global: false }]);
    assert.deepEqual(selectorNames(":global .g1 .g2").classes.map((entry) => entry.global), [true, true]);
    assert.deepEqual(selectorNames(".a:not(.b)[data-x=\".c\"]").classes.map((entry) => entry.name), ["a", "b"]);
  });
});

describe("styles in the graph", () => {
  let graph: Awaited<ReturnType<typeof buildCodeGraph>>;
  let byId: Map<string, GraphNode>;
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/styles-css"), { continueOnError: false });
    byId = new Map(graph.nodes.map((node) => [node.id, node]));
  });
  const file = (id: string) => String(byId.get(id)?.properties.relativePath);
  const styles = (relative: string, kind: string) => graph.nodes
    .filter((node) => node.label === "Style" && node.properties.kind === kind && node.id.startsWith(`file:${relative}:`))
    .map((node) => `${node.properties.name}@${node.properties.line}`).sort();

  it("declares classes, ids, custom properties and rules from the file with their lines", () => {
    assert.deepEqual(styles("css/base.css", "class"), ["btn-primary@16", "btn@16", "only-wide@29", "title@22"]);
    assert.deepEqual(styles("css/base.css", "id"), ["hero@22"]);
    assert.deepEqual(styles("css/base.css", "custom-property"), ["--color-brand@6", "--space@7"]);
    assert.deepEqual(styles("css/theme.css", "custom-property"), ["--accent@1", "--color-brand@8"]);
    assert.equal(styles("css/base.css", "rule").length, 6);
    assert.ok(graph.relationships.filter((rel) => rel.type === "DECLARES_STYLE").every((rel) => byId.get(rel.from)?.label === "File"));
  });

  it("marks CSS Module classes local and :global classes global", () => {
    const scopes = graph.nodes
      .filter((node) => node.label === "Style" && node.properties.kind === "class" && node.id.startsWith("file:css/Card.module.css:"))
      .map((node) => `${node.properties.name}:${node.properties.scope}`).sort();
    assert.deepEqual(scopes, ["card:module", "legacy:global", "outside:global", "title:module"]);
  });

  it("expands SCSS nesting and leaves out names built with interpolation", () => {
    assert.deepEqual(styles("scss/main.scss", "class").map((entry) => entry.split("@")[0]).sort(), ["active", "badge", "dark", "nav", "nav-wide", "nav__item", "uses-placeholder"]);
  });

  it("imports style sheets, partials, folder indexes and url() files as Import → File", () => {
    const resolved = (relative: string) => graph.relationships
      .filter((rel) => rel.type === "IMPORTS" && file(rel.from) === relative)
      .map((rel) => {
        const target = graph.relationships.find((other) => other.type === "RESOLVES_TO" && other.from === rel.to);
        return `${byId.get(rel.to)?.properties.source} -> ${target ? file(target.to) : "-"}`;
      }).sort();
    assert.deepEqual(resolved("css/base.css"), [
      "./reset.css -> css/reset.css",
      "../img/logo.svg -> img/logo.svg",
      "../img/logo.svg -> img/logo.svg",
      "./theme.css -> css/theme.css",
    ].sort());
    assert.deepEqual(resolved("scss/main.scss"), [
      "./vars -> scss/_vars.scss",
      "./vars -> scss/_vars.scss",
      "components -> scss/components/_index.scss",
      "components/button -> scss/components/_button.scss",
      "legacy -> scss/_legacy.scss",
      "pkg/theme -> -",
    ].sort());
    assert.deepEqual(resolved("scss/components/_index.scss"), ["button -> scss/components/_button.scss"]);
    assert.deepEqual(resolved("css/Card.module.css"), ["./base.module.css -> css/base.module.css", "./colors.module.css -> css/colors.module.css"]);
  });

  it("links var(--x) to the custom properties of the project by name", () => {
    const uses = graph.relationships
      .filter((rel) => rel.type === "USES_STYLE")
      .map((rel) => `${file(rel.from)}:${rel.properties.line} ${byId.get(rel.to)?.properties.name} in ${file(graph.relationships.find((other) => other.type === "DECLARES_STYLE" && other.to === rel.to)!.from)} (${rel.properties.match})`)
      .sort();
    assert.deepEqual(uses, [
      "css/Card.module.css:3 --color-brand in css/base.css (name)",
      "css/Card.module.css:3 --color-brand in css/theme.css (name)",
      "css/base.css:18 --color-brand in css/base.css (file)",
      "css/base.css:19 --space in css/base.css (file)",
      "css/base.css:28 --space in css/base.css (file)",
      "css/theme.css:9 --color-brand in css/theme.css (file)",
      "scss/components/_button.scss:2 --color-brand in css/base.css (name)",
      "scss/components/_button.scss:2 --color-brand in css/theme.css (name)",
      "scss/main.scss:12 --nav-height in scss/main.scss (file)",
    ].sort());
    // var(--missing, red) names nothing the project defines, and no transient data is left.
    assert.ok(graph.nodes.every((node) => node.properties.styleVarUses === undefined));
  });

  it("links a rule to the classes and ids it selects", () => {
    const rule = graph.nodes.find((node) => node.label === "Style" && node.properties.kind === "rule" && node.properties.selector === "#hero > .title::before")!;
    const targets = graph.relationships.filter((rel) => rel.type === "SELECTS_STYLE" && rel.from === rule.id).map((rel) => byId.get(rel.to)?.properties.name).sort();
    assert.deepEqual(targets, ["hero", "title"]);
  });
});
