import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { readDockerfile } from "../src/integrations/languages/plain/dockerfile.js";
import { readProto } from "../src/integrations/languages/plain/proto.js";

describe("Dockerfile reader", () => {
  it("joins continuations, drops comments and reads instructions with their lines", () => {
    const read = readDockerfile([
      "# syntax=docker/dockerfile:1",
      "FROM node:22 AS build",
      "RUN npm ci \\",
      "  # a comment inside the instruction",
      "  && npm run build",
      "",
      "ENV A=1 \\",
      "    B=2",
      "CMD [\"node\", \"dist/main.js\"]",
    ].join("\n"));
    assert.deepEqual(read.errors, []);
    assert.deepEqual(read.instructions.map((entry) => [entry.instruction, entry.args, entry.line, entry.endLine]), [
      ["FROM", "node:22 AS build", 2, 2],
      ["RUN", "npm ci && npm run build", 3, 5],
      ["ENV", "A=1 B=2", 7, 8],
      ["CMD", "[\"node\", \"dist/main.js\"]", 9, 9],
    ]);
  });

  it("does not read a heredoc body as instructions", () => {
    const read = readDockerfile("FROM alpine\nRUN <<EOT\nFROM not-an-instruction\nrm -rf /\nEOT\nCMD [\"sh\"]\n");
    assert.deepEqual(read.errors, []);
    assert.deepEqual(read.instructions.map((entry) => entry.instruction), ["FROM", "RUN", "CMD"]);
  });

  it("honours an escape directive", () => {
    const read = readDockerfile("# escape=`\nFROM mcr.microsoft.com/windows\nRUN echo a `\n  b\n");
    assert.deepEqual(read.errors, []);
    assert.equal(read.instructions[1]?.args, "echo a b");
  });

  it("reports an unknown instruction, an open heredoc and a bad ONBUILD", () => {
    const read = readDockerfile("FROM\nRUNN x\nRUN <<EOF\necho\nONBUILD FROM x\n");
    assert.deepEqual(read.errors.map((error) => [error.line, error.message]), [
      [1, "FROM needs an image"],
      [2, "Unknown instruction \"RUNN\""],
      [3, "Heredoc \"EOF\" is not closed"],
    ]);
  });
});

describe("proto reader", () => {
  const source = [
    "// users",
    "syntax = \"proto3\";",
    "package users.v1;",
    "import public \"google/protobuf/empty.proto\";",
    "option go_package = \"example.com/users\";",
    "service Users {",
    "  option deprecated = false;",
    "  rpc Get (GetRequest) returns (User);",
    "  rpc Watch (stream GetRequest) returns (stream User) { option idempotency_level = NO_SIDE_EFFECTS; }",
    "}",
    "message GetRequest { string id = 1; }",
    "message User { string id = 1; message Nested {} }",
    "enum Kind { UNKNOWN = 0; }",
  ].join("\n");

  it("reads syntax, package, imports, messages, enums, services and rpcs", () => {
    const read = readProto(source);
    assert.deepEqual(read.errors, []);
    assert.equal(read.syntax, "proto3");
    assert.equal(read.package, "users.v1");
    assert.deepEqual(read.imports, [{ path: "google/protobuf/empty.proto", modifier: "public", line: 4 }]);
    assert.deepEqual(read.messages.map((message) => message.name), ["GetRequest", "User"]);
    assert.deepEqual(read.enums.map((entry) => entry.name), ["Kind"]);
    assert.deepEqual(read.services.map((service) => [service.name, service.line]), [["Users", 6]]);
    assert.deepEqual(read.services[0]!.rpcs.map((rpc) => [rpc.name, rpc.request, rpc.response, rpc.clientStreaming, rpc.serverStreaming, rpc.line]), [
      ["Get", "GetRequest", "User", false, false, 8],
      ["Watch", "GetRequest", "User", true, true, 9],
    ]);
  });

  it("reports unclosed blocks, strings and comments, and unknown statements", () => {
    assert.ok(readProto("service S { rpc A (Q) returns (R);\n").errors.some((error) => /not closed/u.test(error.message)));
    assert.ok(readProto("import \"a.proto;\n").errors.some((error) => /String is not closed/u.test(error.message)));
    assert.ok(readProto("/* open\nmessage M {}\n").errors.some((error) => /Comment is not closed/u.test(error.message)));
    assert.ok(readProto("frobnicate x;\n").errors.some((error) => /Unknown statement/u.test(error.message)));
  });
});

describe("syntax errors in non-code files", () => {
  let warnings: Map<string, string>;
  let files: Set<string>;
  before(async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/non-code-syntax"), { continueOnError: false });
    warnings = new Map(graph.report.warnings.map((warning) => [warning.path, warning.message]));
    files = new Set(graph.nodes.filter((node) => node.label === "File").map((node) => String(node.properties.relativePath)));
  });

  it("warns once per file with the lines, and keeps the File node", () => {
    assert.deepEqual([...warnings.keys()].sort(), ["Dockerfile", "Makefile", "broken.json", "broken.ps1", "broken.proto", "broken.sh", "broken.yml"].sort());
    for (const file of warnings.keys()) assert.ok(files.has(file), file);
    assert.equal(warnings.get("broken.json"), "Syntax error at line 1");
    assert.equal(warnings.get("Dockerfile"), "Syntax error at line 2");
    assert.equal(warnings.get("broken.proto"), "Syntax error at line 2");
  });

  it("does not warn for comment-tolerant JSON, YAML templates, modern CSS, SQL dialects and valid files", () => {
    for (const file of ["tsconfig.base.json", "settings.jsonc", ".vscode/settings.json", "ci/template.yaml", "modern.css", "dialect.sql", "ok.yml", "ok.sh", "Dockerfile.ok", "ok.proto"]) {
      assert.ok(files.has(file), `${file} is a File node`);
      assert.equal(warnings.has(file), false, file);
    }
  });
});
