import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeMemberCallExpression } from "../src/parsers/tree-sitter-utils.js";

describe("analyzeMemberCallExpression", () => {
  it("returns null for undefined input", () => {
    assert.equal(analyzeMemberCallExpression(undefined), null);
  });

  it("returns null for empty string", () => {
    assert.equal(analyzeMemberCallExpression(""), null);
  });

  it("handles a plain identifier with no dot", () => {
    const result = analyzeMemberCallExpression("initialize");
    assert.deepEqual(result, { expression: "initialize", callee: "initialize", receiver: null });
  });

  it("handles a simple member expression", () => {
    const result = analyzeMemberCallExpression("router.get");
    assert.deepEqual(result, { expression: "router.get", callee: "get", receiver: "router" });
  });

  it("handles a nested member expression", () => {
    const result = analyzeMemberCallExpression("this.service.create");
    assert.deepEqual(result, {
      expression: "this.service.create",
      callee: "create",
      receiver: "this.service",
    });
  });

  it("strips call expression from receiver in a chained call", () => {
    const result = analyzeMemberCallExpression("app.use(cors()).use");
    assert.deepEqual(result, {
      expression: "app.use(cors()).use",
      callee: "use",
      receiver: "app",
    });
  });

  it("strips deeply chained receiver to root identifier", () => {
    const result = analyzeMemberCallExpression("app.use(cors()).use(json()).listen");
    assert.deepEqual(result, {
      expression: "app.use(cors()).use(json()).listen",
      callee: "listen",
      receiver: "app",
    });
  });

  it("strips call on bare identifier receiver", () => {
    const result = analyzeMemberCallExpression("express().Router");
    assert.deepEqual(result, {
      expression: "express().Router",
      callee: "Router",
      receiver: "express",
    });
  });

  it("preserves receiver that contains dots but no parens", () => {
    const result = analyzeMemberCallExpression("req.body.name");
    assert.deepEqual(result, {
      expression: "req.body.name",
      callee: "name",
      receiver: "req.body",
    });
  });
});
