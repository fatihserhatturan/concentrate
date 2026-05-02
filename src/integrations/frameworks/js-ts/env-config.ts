import type Parser from "tree-sitter";
import type { GraphNode, GraphRelationship } from "../../../graph/model.js";
import {
  createConfigValueGraph,
  createFileEnvUsageGraph,
  createFunctionEnvUsageGraph,
} from "../../../parsers/js-ts/env-config.js";
import { GraphBuilder } from "../../../graph/builder.js";
import { addEnvAndConfigRelationships } from "../../../scanner/resolution/env-config.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";

// Parse-time env/config semantic module.
// Applies three layers of env/config extraction to a file:
//   1. Per-function: process.env.* accesses inside each function body.
//   2. Per-variable-declarator: config value declarations at module scope.
//   3. File-level: process.env.* accesses at module scope.
//
// functionAstPairs and variableDeclaratorAstNodes are collected during the
// language-level walk and passed here to avoid re-traversing the AST.
export function applyEnvConfigParseSemantics(
  fileNodeId: string,
  programNode: Parser.SyntaxNode,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  functionAstPairs: Array<{ functionNodeId: string; astNode: Parser.SyntaxNode }>,
  variableDeclaratorAstNodes: Parser.SyntaxNode[],
): void {
  for (const { functionNodeId, astNode } of functionAstPairs) {
    const usage = createFunctionEnvUsageGraph(functionNodeId, astNode);
    nodes.push(...usage.nodes);
    relationships.push(...usage.relationships);
  }

  for (const declarator of variableDeclaratorAstNodes) {
    const configValue = createConfigValueGraph(fileNodeId, declarator);
    if (configValue) {
      nodes.push(configValue.node);
      relationships.push(configValue.relationship);
    }
  }

  const fileUsage = createFileEnvUsageGraph(fileNodeId, programNode);
  nodes.push(...fileUsage.nodes);
  relationships.push(...fileUsage.relationships);
}

// Post-parse env/config resolution: links EnvVar and ConfigValue nodes
// across files (e.g. imported config modules to their consumers).
export const envConfigContributor: ISemanticContributor = {
  contribute(graph) {
    addEnvAndConfigRelationships(graph as unknown as GraphBuilder);
  },
};
