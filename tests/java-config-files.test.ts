import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  canonicalKey,
  envNameToKey,
  flattenYamlDocuments,
  isSpringConfigFile,
  keyToEnvName,
  looseKey,
  parsePlaceholders,
  parseProperties,
  placeholderKeys,
  profileMatches,
  readSpringConfig,
  resolvePlaceholders,
  springConfigProfile,
} from "../src/integrations/frameworks/java/config-files.js";

describe("Spring config file names", () => {
  it("accepts application and bootstrap files in resources directories", () => {
    assert.equal(springConfigProfile("src/main/resources/application.properties"), null);
    assert.equal(springConfigProfile("app/src/main/resources/application-dev.yml"), "dev");
    assert.equal(springConfigProfile("src/test/resources/application-test.yaml"), "test");
    assert.equal(springConfigProfile("svc/resources/bootstrap.yml"), null);
    assert.equal(springConfigProfile("src/main/resources/config/application-prod.properties"), "prod");
    assert.equal(springConfigProfile("src/main/resources/application-eu-west.yml"), "eu-west");
    assert.equal(springConfigProfile("src/main/java/application.yml"), undefined);
    assert.equal(springConfigProfile("src/main/resources/other.yml"), undefined);
    assert.equal(springConfigProfile("src/main/resources/nested/application.yml"), undefined);
    assert.ok(isSpringConfigFile("src/main/resources/application.yml"));
    assert.ok(!isSpringConfigFile("docker-compose.yml"));
  });
});

describe("relaxed binding keys", () => {
  it("canonicalizes kebab, camel, underscore and upper case", () => {
    assert.equal(canonicalKey("myApp.apiUrl"), "my-app.api-url");
    assert.equal(canonicalKey("my_app.API_URL"), "my-app.api-url");
    assert.equal(canonicalKey("my-app.api-url"), "my-app.api-url");
    assert.equal(canonicalKey("servers[0].hostName"), "servers[0].host-name");
    assert.equal(canonicalKey("app.HTTPServer.port"), "app.http-server.port");
    assert.equal(looseKey("myApp.apiUrl"), looseKey("MYAPP.APIURL"));
    assert.equal(keyToEnvName("my-app.api-url"), "MYAPP_APIURL");
    assert.equal(keyToEnvName("servers[0].host"), "SERVERS_0_HOST");
    assert.equal(envNameToKey("MY_APP_URL"), "my.app.url");
    assert.equal(envNameToKey("SERVERS_0_HOST"), "servers[0].host");
  });
});

describe("placeholders", () => {
  it("parses keys, defaults and nesting", () => {
    assert.deepEqual(parsePlaceholders("a ${b} c"), [{ text: "a " }, { key: [{ text: "b" }], default: null }, { text: " c" }]);
    assert.deepEqual(parsePlaceholders("${a:x:y}"), [{ key: [{ text: "a" }], default: [{ text: "x:y" }] }]);
    assert.deepEqual(parsePlaceholders("${a:}"), [{ key: [{ text: "a" }], default: [] }]);
    assert.deepEqual(parsePlaceholders("${a.${b}:${c:d}}"), [{
      key: [{ text: "a." }, { key: [{ text: "b" }], default: null }],
      default: [{ key: [{ text: "c" }], default: [{ text: "d" }] }],
    }]);
    assert.deepEqual(parsePlaceholders("cost ${unclosed"), [{ text: "cost ${unclosed" }]);
    assert.deepEqual(placeholderKeys("${a}/${b:${c}}/${d.${e}}"), ["a", "b", "c", "e"]);
  });

  it("resolves from a lookup, falls back to defaults and lists what is missing", () => {
    const values: Record<string, string> = { host: "h", "env.name": "dev", "api.dev": "http://dev" };
    const lookup = (key: string) => values[key];
    assert.deepEqual(resolvePlaceholders("http://${host}:${port:80}/x", lookup), { value: "http://h:80/x", unresolved: [] });
    assert.deepEqual(resolvePlaceholders("${api.${env.name}}", lookup), { value: "http://dev", unresolved: [] });
    assert.deepEqual(resolvePlaceholders("${PORT}/${HOST:x}", lookup), { value: "${PORT}/x", unresolved: ["PORT"] });
    assert.deepEqual(resolvePlaceholders("plain", lookup), { value: "plain", unresolved: [] });
  });
});

describe("properties and YAML", () => {
  it("reads .properties syntax with lines", () => {
    const entries = parseProperties([
      "# comment",
      "a.b=1",
      "c.d : two words  ",
      "! other comment",
      "e f",
      "long=first \\",
      "    second",
      "esc\\:aped=v\\u0041",
      "empty=",
      "list[0]=x",
    ].join("\n"));
    assert.deepEqual(entries, [
      { key: "a.b", value: "1", line: 2 },
      { key: "c.d", value: "two words", line: 3 },
      { key: "e", value: "f", line: 5 },
      { key: "long", value: "first second", line: 6 },
      { key: "esc:aped", value: "vA", line: 8 },
      { key: "empty", value: "", line: 9 },
      { key: "list[0]", value: "x", line: 10 },
    ]);
  });

  it("flattens YAML maps, lists and every document with profiles", async () => {
    const documents = await flattenYamlDocuments([
      "server:",
      "  port: 8080",
      "spring:",
      "  datasource:",
      "    url: jdbc:h2:mem:db",
      "servers:",
      "  - host: a",
      "    port: 1",
      "  - host: b",
      "tags: [x, y]",
      "empty:",
      "---",
      "spring:",
      "  config:",
      "    activate:",
      "      on-profile: prod",
      "server:",
      "  port: 9090",
    ].join("\n"));
    assert.equal(documents?.length, 2);
    assert.deepEqual(documents![0]!.entries.map((entry) => `${entry.line}:${entry.key}=${entry.value}`), [
      "2:server.port=8080",
      "5:spring.datasource.url=jdbc:h2:mem:db",
      "7:servers[0].host=a",
      "8:servers[0].port=1",
      "9:servers[1].host=b",
      "10:tags[0]=x",
      "10:tags[1]=y",
      "11:empty=",
    ]);
    assert.equal(documents![0]!.profile, null);
    assert.equal(documents![1]!.profile, "prod");
    assert.deepEqual(documents![1]!.entries.map((entry) => `${entry.line}:${entry.key}=${entry.value}`), ["18:server.port=9090"]);
    assert.equal(await flattenYamlDocuments("a: [1, 2\nb: {"), null);
  });

  it("evaluates profile expressions", () => {
    assert.ok(profileMatches(null, []));
    assert.ok(profileMatches("dev", ["dev"]));
    assert.ok(!profileMatches("dev", ["prod"]));
    assert.ok(profileMatches("dev | prod", ["prod"]));
    assert.ok(profileMatches("!prod", ["dev"]));
    assert.ok(profileMatches("a & b", ["a", "b"]));
    assert.ok(!profileMatches("a & b", ["a"]));
  });
});

describe("the config of a scan", () => {
  async function withProject(files: Record<string, string>, run: (root: string, absolute: string[]) => Promise<void>) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-config-"));
    try {
      for (const [name, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
        await writeFile(path.join(dir, name), text);
      }
      await run(dir, Object.keys(files).map((name) => path.join(dir, name)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const FILES = {
    "src/main/resources/application.properties": "app.api-url=http://base\napp.name=${NAME:demo}\napp.host=${HOST}\nspring.profiles.active=dev\nrefs=${app.apiUrl}/v1\n",
    "src/main/resources/application-dev.yml": "app:\n  apiUrl: http://dev\n  retries: 3\n",
    "src/main/resources/application.yml": "app:\n  other: 1\n---\nspring.profiles: prod\napp:\n  apiUrl: http://prod\n",
    "billing/src/main/resources/application.yml": "app:\n  api-url: http://billing\n",
    "src/main/java/application.yml": "ignored: true\n",
    "docs/application.yml": "ignored: true\n",
  };

  it("reads files, files by profile and looks keys up with relaxed binding", async () => {
    await withProject(FILES, async (root, absolute) => {
      const config = await readSpringConfig(root, absolute);
      assert.deepEqual([...config.files], [
        "billing/src/main/resources/application.yml",
        "src/main/resources/application-dev.yml",
        "src/main/resources/application.properties",
        "src/main/resources/application.yml",
      ]);
      const entry = config.lookup("app.apiUrl", { near: "src/main/java/A.java" });
      assert.deepEqual([entry?.value, entry?.file, entry?.line, entry?.profile, entry?.format], ["http://base", "src/main/resources/application.properties", 1, null, "properties"]);
      assert.equal(config.lookup("APP.API_URL", { profile: "dev", near: "src/main/java/A.java" })?.value, "http://dev");
      assert.equal(config.lookup("app.api-url", { profile: ["prod"], near: "src/main/java/A.java" })?.value, "http://prod");
      assert.equal(config.lookup("app.api-url", { near: "billing/src/main/java/B.java" })?.value, "http://billing");
      assert.equal(config.lookup("app.retries")?.line, 3);
      assert.equal(config.lookup("missing.key"), null);
      assert.deepEqual(config.activeProfiles(), ["dev"]);
      assert.deepEqual(config.withPrefix("app", { near: "src/main/java/A.java" }).map((item) => item.key).sort(), ["app.api-url", "app.host", "app.name", "app.other", "app.retries"]);
    });
  });

  it("resolves placeholders against the entries and lists the environment candidates", async () => {
    await withProject(FILES, async (root, absolute) => {
      const config = await readSpringConfig(root, absolute);
      const near = { near: "src/main/java/A.java" };
      assert.deepEqual(config.resolveText("${app.apiUrl}/x", near), { value: "http://base/x", unresolved: [] });
      assert.deepEqual(config.resolveText("${refs}", near), { value: "http://base/v1", unresolved: [] });
      assert.deepEqual(config.resolveText("${app.name}", near), { value: "demo", unresolved: [] });
      assert.deepEqual(config.resolveText("${app.host}", near), { value: "${HOST}", unresolved: ["HOST"] });
      assert.deepEqual(config.resolveText("${API_HOST}:${PORT:8080}", near), { value: "${API_HOST}:8080", unresolved: ["API_HOST"] });
    });
  });

  it("is read once per root while the files are unchanged", async () => {
    await withProject(FILES, async (root, absolute) => {
      const first = await readSpringConfig(root, absolute);
      assert.equal(await readSpringConfig(root, absolute), first);
      await writeFile(path.join(root, "src/main/resources/application.properties"), "app.name=changed-and-longer\n");
      const second = await readSpringConfig(root, absolute);
      assert.notEqual(second, first);
      assert.equal(second.lookup("app.name")?.value, "changed-and-longer");
    });
  });
});
