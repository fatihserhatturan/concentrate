import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { GraphBuilder } from "../src/core/graph/builder.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import { javaFrameworkParser } from "../src/integrations/frameworks/java/index.js";
import { createJavaParser } from "../src/integrations/languages/java/parser.js";
import { createFileReceiverResolver, createJavaReceiverResolver, receiverMatches, type JavaReceiverResolver, type JavaReceiverType } from "../src/integrations/frameworks/java/receivers.js";

const FILES: Record<string, string> = {
  "src/main/java/com/acme/BaseRepo.java": `package com.acme;
import org.springframework.jdbc.core.JdbcTemplate;
public abstract class BaseRepo { protected JdbcTemplate jdbc; }
`,
  "src/main/java/com/acme/Holder.java": `package com.acme;
import org.springframework.web.client.RestTemplate;
public class Holder { public static final RestTemplate SHARED = new RestTemplate(); public RestTemplate inner; }
`,
  "src/main/java/com/acme/UserRepo.java": `package com.acme;

import java.net.http.HttpClient;
import java.util.List;
import org.springframework.jdbc.core.*;
import org.springframework.jdbc.core.namedparam.*;
import org.springframework.web.client.RestTemplate;

public class UserRepo extends BaseRepo {
  private final NamedParameterJdbcTemplate named;
  private final RestTemplate rest;
  private final Holder holder;
  private final List<String> names;

  public UserRepo(NamedParameterJdbcTemplate named, RestTemplate rest, Holder holder, List<String> names) {
    this.named = named; this.rest = rest; this.holder = holder; this.names = names;
  }

  void run(RestTemplate param) {
    named.query("x", null);
    this.rest.getForObject("u", String.class);
    param.getForObject("u", String.class);
    jdbc.query("x", (rs, n) -> n);
    JdbcTemplate local = new JdbcTemplate();
    local.update("x");
    var created = new RestTemplate();
    created.getForObject("u", String.class);
    var unknown = factory();
    unknown.getForObject("u", String.class);
    holder.inner.getForObject("u", String.class);
    Holder.SHARED.getForObject("u", String.class);
    HttpClient.newHttpClient().send(null, null);
    new RestTemplate().getForObject("u", String.class);
    ((RestTemplate) unknown).getForObject("u", String.class);
    names.size();
    factory().getForObject("u", String.class);
    other.getForObject("u", String.class);
  }

  RestTemplate factory() { return null; }

  class Nested { void go() { rest.getForObject("u", String.class); } }
}
`,
};

const JDBC = "org.springframework.jdbc.core.JdbcTemplate";
const NAMED = "org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate";
const REST = "org.springframework.web.client.RestTemplate";

// `receiver.callee` of the calls of `UserRepo.run` and `Nested.go` → the type found (typeName or null).
function typesOf(resolver: JavaReceiverResolver, nodes: readonly { label: string; id: string; properties: Record<string, unknown> }[], relationships: readonly { from: string; to: string; type: string }[], methodName: string): Map<string, JavaReceiverType | null> {
  const fn = nodes.find((node) => node.label === "Function" && node.properties.name === methodName)!;
  const result = new Map<string, JavaReceiverType | null>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const rel of relationships) {
    if (rel.type !== "CALLS" || rel.from !== fn.id) continue;
    const call = byId.get(rel.to)!;
    if (call.properties.callKind !== "method") continue;
    result.set(String(call.properties.expression), resolver.typeOfCall(call as never, fn as never));
  }
  return result;
}

describe("Java receiver types over the graph", () => {
  it("finds the declared type of fields, parameters, locals, statics and constructions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-receivers-"));
    try {
      for (const [name, text] of Object.entries(FILES)) {
        await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
        await writeFile(path.join(dir, name), text);
      }
      // The parsed files as they are before resolution (a scan drops the calls nothing resolves).
      const graph: { nodes: GraphNode[]; relationships: GraphRelationship[] } = { nodes: [], relationships: [] };
      for (const name of Object.keys(FILES)) {
        const parsed = await javaFrameworkParser.parse(dir, path.join(dir, name));
        graph.nodes.push(...parsed.nodes);
        graph.relationships.push(...parsed.relationships);
      }
      const builder = new GraphBuilder();
      builder.addNodes(graph.nodes);
      builder.addRelationships(graph.relationships);
      const resolver = createJavaReceiverResolver(builder);
      const types = typesOf(resolver, graph.nodes, graph.relationships, "run");
      const brief = (expression: string) => {
        const type = types.get(expression);
        return type === undefined ? "missing" : type === null ? null : `${type.typeName}|${type.qualifiedName}|${type.via}`;
      };
      // A constructor-injected final field written with a wildcard import: the name is only a candidate.
      assert.equal(brief("named.query"), "NamedParameterJdbcTemplate|null|field");
      assert.ok(receiverMatches(types.get("named.query"), [NAMED]));
      assert.ok(!receiverMatches(types.get("named.query"), [JDBC]));
      assert.equal(brief("this.rest.getForObject"), `RestTemplate|${REST}|field`);
      assert.equal(brief("param.getForObject"), `RestTemplate|${REST}|local`);
      // A field inherited from a scanned superclass of another file.
      assert.equal(brief("jdbc.query"), "JdbcTemplate|null|field");
      assert.ok(receiverMatches(types.get("jdbc.query"), [JDBC]));
      assert.equal(brief("local.update"), "JdbcTemplate|null|local");
      assert.ok(receiverMatches(types.get("local.update"), [JDBC]));
      assert.equal(brief("created.getForObject"), `RestTemplate|${REST}|local`);
      // `var x = f()` has no known type, and shadows nothing it could be confused with.
      assert.equal(brief("unknown.getForObject"), null);
      // A field chain through a scanned type's field, and a static field.
      assert.equal(brief("holder.inner.getForObject"), `RestTemplate|${REST}|field`);
      assert.equal(brief("Holder.SHARED.getForObject"), `RestTemplate|${REST}|field`);
      // A static call on an external type named by a single-type import.
      assert.equal(brief("HttpClient.newHttpClient().send"), null);
      assert.equal(brief("new RestTemplate().getForObject"), `RestTemplate|${REST}|new`);
      assert.equal(brief("((RestTemplate)unknown).getForObject"), `RestTemplate|${REST}|local`);
      assert.equal(brief("names.size"), "List|java.util.List|field");
      // Call chains and names that are nothing are unknown.
      assert.equal(brief("factory().getForObject"), null);
      assert.equal(brief("other.getForObject"), null);

      // The field of the outer class from a nested class.
      const nested = typesOf(resolver, graph.nodes, graph.relationships, "go");
      assert.equal(nested.get("rest.getForObject")?.qualifiedName, REST);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Java receiver types in one file (parse time)", () => {
  it("uses the file's own types and imports", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-receivers-"));
    try {
      const file = path.join(dir, "UserRepo.java");
      await writeFile(file, FILES["src/main/java/com/acme/UserRepo.java"]!);
      let found: Map<string, JavaReceiverType | null> | null = null;
      const parser = createJavaParser([({ fileNodeId, nodes, relationships }) => {
        found = typesOf(createFileReceiverResolver({ fileNodeId, nodes, relationships }), nodes, relationships, "run");
      }]);
      await parser.parse(dir, file);
      const types = found!;
      assert.equal(types.get("this.rest.getForObject")?.qualifiedName, REST);
      assert.equal(types.get("param.getForObject")?.qualifiedName, REST);
      assert.equal(types.get("created.getForObject")?.qualifiedName, REST);
      assert.ok(receiverMatches(types.get("local.update"), [JDBC]));
      assert.equal(types.get("names.size")?.qualifiedName, "java.util.List");
      // `jdbc` is inherited from a type of another file: not known here.
      assert.equal(types.get("jdbc.query"), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
