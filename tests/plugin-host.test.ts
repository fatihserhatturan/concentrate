import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { createScanDependencies } from "../src/composition/orchestrator.js";
import { coreIntegrationRegistry, createDefaultCoreIntegrationRegistry } from "../src/composition/default-registry.js";
import { parserFingerprint } from "../src/composition/parser-fingerprint.js";
import { createEmptyCoreIntegrationRegistry } from "../src/core/integrations/registry.js";
import type { ILanguageResolver } from "../src/core/contracts/language-resolver.js";
import type { ISemanticContributor, ScanLifecycleContext } from "../src/core/contracts/semantic-contributor.js";
import { createToyRegistry } from "./helpers/toy-plugin.js";

const toyModule = pathToFileURL(path.join(import.meta.dirname, "helpers", "toy-plugin.ts"));

async function toyProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-host-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.toy"), "fn main\ncall helper\n");
  await writeFile(path.join(root, "src", "b.toy"), "fn helper\n");
  return root;
}

const contributor = (id: string, extra: Partial<ISemanticContributor> = {}): ISemanticContributor => ({ id, contribute() {}, ...extra });
const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);

describe("a custom registry through the composition layer", () => {
  it("scans on the main thread with the registry it is given", async () => {
    const root = await toyProject();
    try {
      const registry = createToyRegistry();
      for (const scanner of [registry, createScanDependencies(registry)]) {
        const result = await buildCodeGraph(root, { continueOnError: false, workers: 2, keepCallSites: true }, scanner);
        // No registry module: no workers, even when asked for.
        assert.equal(result.report.parseWorkers, 0);
        const files = result.nodes.filter((node) => node.label === "File" && node.properties.language === "toy");
        assert.deepEqual(files.map((file) => file.properties.parsedIn), ["main", "main"]);
        assert.equal(result.relationships.filter((relationship) => relationship.type === "CALL_RESOLVES_TO").length, 1);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not know the language when the default registry scans", async () => {
    const root = await toyProject();
    try {
      const result = await buildCodeGraph(root, { continueOnError: false, workers: 0 });
      assert.equal(result.nodes.some((node) => node.properties.language === "toy"), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses on workers that build the registry from a registry module", async () => {
    const root = await toyProject();
    try {
      const deps = createScanDependencies(createToyRegistry(), { registryModule: toyModule });
      const result = await buildCodeGraph(root, { continueOnError: false, workers: 2, keepCallSites: true }, deps);
      assert.equal(result.report.parseWorkers, 2);
      assert.equal(result.report.failedFiles.length, 0);
      const files = result.nodes.filter((node) => node.label === "File" && node.properties.language === "toy");
      assert.deepEqual(files.map((file) => file.properties.parsedIn), ["worker", "worker"]);
      assert.equal(result.relationships.filter((relationship) => relationship.type === "CALL_RESOLVES_TO").length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the scan's registry on the main thread when a worker cannot build its registry", async () => {
    const root = await toyProject();
    try {
      const missing = pathToFileURL(path.join(root, "no-such-module.ts"));
      const deps = createScanDependencies(createToyRegistry(), { registryModule: missing });
      const result = await buildCodeGraph(root, { continueOnError: false, workers: 2 }, deps);
      assert.equal(result.report.failedFiles.length, 0);
      const files = result.nodes.filter((node) => node.label === "File" && node.properties.language === "toy");
      assert.deepEqual(files.map((file) => file.properties.parsedIn), ["main", "main"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("contributor ordering", () => {
  it("keeps registration order without dependencies, and is stable with them", () => {
    const registry = createEmptyCoreIntegrationRegistry();
    registry.registerSemanticContributor(contributor("a", { dependsOn: ["c"] }));
    registry.registerSemanticContributor(contributor("b"));
    registry.registerSemanticContributor(contributor("c"));
    registry.registerSemanticContributor(contributor("d", { dependsOn: ["a"] }));
    registry.registerSemanticContributor(contributor("e"));
    // b is the earliest registered that is ready; a follows c; d follows a, e comes last.
    assert.deepEqual(ids(registry.semanticContributors), ["b", "c", "a", "d", "e"]);
    registry.registerSemanticContributor(contributor("f"));
    assert.deepEqual(ids(registry.semanticContributors), ["b", "c", "a", "d", "e", "f"]);

    const plain = createEmptyCoreIntegrationRegistry();
    for (const id of ["z", "y", "x"]) plain.registerSemanticContributor(contributor(id));
    assert.deepEqual(ids(plain.semanticContributors), ["z", "y", "x"]);
  });

  it("rejects an unknown dependency, a cycle and a duplicate id", () => {
    const unknown = createEmptyCoreIntegrationRegistry();
    unknown.registerSemanticContributor(contributor("a", { dependsOn: ["missing"] }));
    assert.throws(() => unknown.semanticContributors, /a depends on unknown contributor: missing/u);

    const cycle = createEmptyCoreIntegrationRegistry();
    cycle.registerSemanticContributor(contributor("a", { dependsOn: ["b"] }));
    cycle.registerSemanticContributor(contributor("b", { dependsOn: ["a"] }));
    cycle.registerSemanticContributor(contributor("c"));
    assert.throws(() => cycle.semanticContributors, /cycle: a, b/u);

    const duplicate = createEmptyCoreIntegrationRegistry();
    duplicate.registerSemanticContributor(contributor("a"));
    assert.throws(() => duplicate.registerSemanticContributor(contributor("a")), /already registered: a/u);
  });

  it("surfaces an ordering error when a scan starts", async () => {
    const root = await toyProject();
    try {
      const registry = createToyRegistry();
      registry.registerSemanticContributor(contributor("needs-nothing-known", { dependsOn: ["nope"] }));
      await assert.rejects(buildCodeGraph(root, { continueOnError: false, workers: 0 }, registry), /unknown contributor: nope/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("orders the default registry as it was registered, with unique ids", () => {
    const list = coreIntegrationRegistry.semanticContributors;
    assert.equal(new Set(ids(list)).size, list.length);
    assert.deepEqual(ids(list.slice(0, 3)), ["js-ts.nestjs-modules", "js-ts.nestjs-injection", "js-ts.instance-methods"]);
    assert.deepEqual(ids(list.slice(-2)), ["sql.schema", "proto.rpc-messages"]);
    const position = (id: string) => ids(list).indexOf(id);
    for (const dataAccess of ["js-ts.data-access", "go.data-access", "rust.data-access", "cpp.data-access"]) {
      assert.ok(position(dataAccess) >= 0 && position(dataAccess) < position("sql.schema"), dataAccess);
    }
    assert.deepEqual(ids(createDefaultCoreIntegrationRegistry().languageResolvers), ["core.imports", "core.package-imports", "core.inheritance", "core.calls"]);
  });
});

describe("scan lifecycle hooks", () => {
  it("calls prepare before and finish after the resolution of a scan, once each", async () => {
    const root = await toyProject();
    try {
      const events: string[] = [];
      const contexts: ScanLifecycleContext[] = [];
      const resolver: ILanguageResolver = {
        id: "probe.resolver",
        prepare(context) { events.push("resolver.prepare"); contexts.push(context); },
        resolve() { events.push("resolver.resolve"); },
        finish() { events.push("resolver.finish"); },
      };
      const probe = contributor("probe.contributor", {
        prepare(context) { events.push("contributor.prepare"); contexts.push(context); },
        contribute() { events.push("contributor.contribute"); },
        finish() { events.push("contributor.finish"); },
      });
      const registry = createToyRegistry();
      registry.registerLanguageResolver(resolver);
      registry.registerSemanticContributor(probe);
      await buildCodeGraph(root, { continueOnError: false, workers: 0, apiOrigins: ["https://api.example.test"] }, registry);

      assert.deepEqual(events, [
        "resolver.prepare",
        "contributor.prepare",
        "resolver.resolve",
        "contributor.contribute",
        "resolver.finish",
        "contributor.finish",
      ]);
      for (const context of contexts) {
        assert.equal(context.rootPath, path.resolve(root));
        assert.equal(context.files.some((file) => file.endsWith("a.toy")), true);
        assert.deepEqual(context.settings.apiOrigins, ["https://api.example.test"]);
        assert.equal(typeof context.report.parsedFiles, "number");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("calls finish when a contributor fails", async () => {
    const root = await toyProject();
    try {
      const events: string[] = [];
      const registry = createToyRegistry();
      registry.registerSemanticContributor(contributor("probe.failing", {
        contribute() { throw new Error("boom"); },
        finish() { events.push("finish"); },
      }));
      await assert.rejects(buildCodeGraph(root, { continueOnError: false, workers: 0 }, registry), /boom/u);
      assert.deepEqual(events, ["finish"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("parser fingerprint", () => {
  it("changes with the version of a registered integration, and with the integrations registered", async () => {
    const base = await parserFingerprint(createToyRegistry());
    assert.equal(await parserFingerprint(createToyRegistry()), base, "same integrations, same fingerprint");
    assert.notEqual(await parserFingerprint(createToyRegistry("1.0.0")), base);
    assert.notEqual(await parserFingerprint(createToyRegistry("1.0.0")), await parserFingerprint(createToyRegistry("1.0.1")));
    assert.notEqual(await parserFingerprint(createDefaultCoreIntegrationRegistry()), base, "a plugin language is part of it");

    const withContributor = createToyRegistry();
    withContributor.registerSemanticContributor(contributor("probe.versioned", { version: "1" }));
    const bumped = createToyRegistry();
    bumped.registerSemanticContributor(contributor("probe.versioned", { version: "2" }));
    assert.notEqual(await parserFingerprint(withContributor), await parserFingerprint(bumped));
  });

  it("is what a scan's dependencies report", async () => {
    const registry = createToyRegistry("3");
    assert.equal(await createScanDependencies(registry).parserFingerprint!(), await parserFingerprint(registry));
  });
});
