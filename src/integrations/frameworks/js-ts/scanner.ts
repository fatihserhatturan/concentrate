import path from "node:path";
import { readFile } from "node:fs/promises";
import type { ParsedSourceFile } from "../../../core/graph/model.js";
import type { SupportedLanguage } from "../../../core/scan/language.js";
import type { ILanguageParser } from "../../../core/contracts/language-parser.js";
import {
  walkJsTsNodes,
  finalizeLanguageLevel,
  parseTree,
  parseJsTsLanguageOnly,
  parseJsTsWithRootNode,
} from "../../languages/js-ts/parser.js";
import { applyExpressKoaParseSemantics } from "./express-koa.js";
import { applyFastifyParseSemantics } from "./fastify.js";
import { applyNestJsParseSemantics } from "./nestjs.js";
import { applyBackendEntrypointParseSemantics } from "./backend-entrypoints.js";
import { applyEnvConfigParseSemantics } from "./env-config.js";

export { parseJsTsLanguageOnly, parseJsTsWithRootNode };

export const javascriptParser: ILanguageParser = {
  language: "javascript",
  parse: (rootPath, filePath) => parseJavaScriptLikeFile(rootPath, filePath, "javascript"),
};

export const typescriptParser: ILanguageParser = {
  language: "typescript",
  parse: (rootPath, filePath) => parseJavaScriptLikeFile(rootPath, filePath, "typescript"),
};

function applyFrameworkSemantics(
  fileNodeId: string,
  tree: ReturnType<typeof parseTree>,
  parsed: ParsedSourceFile,
  state: ReturnType<typeof walkJsTsNodes>,
): void {
  applyEnvConfigParseSemantics(
    fileNodeId,
    tree.rootNode,
    parsed.nodes,
    parsed.relationships,
    state.functionAstPairs,
    state.variableDeclaratorAstNodes,
  );

  applyExpressKoaParseSemantics(fileNodeId, tree.rootNode, parsed.nodes, parsed.relationships);
  applyFastifyParseSemantics(fileNodeId, tree.rootNode, parsed.nodes, parsed.relationships);
  applyNestJsParseSemantics(fileNodeId, parsed.nodes, parsed.relationships);
  applyBackendEntrypointParseSemantics(fileNodeId, tree.rootNode, parsed.nodes, parsed.relationships);
}

async function parseJavaScriptLikeFile(
  rootPath: string,
  filePath: string,
  language: SupportedLanguage,
): Promise<ParsedSourceFile> {
  const source = await readFile(filePath, "utf8");
  const relativePath = path.relative(rootPath, filePath);
  const fileNodeId = `file:${relativePath}`;

  const fileNode = {
    id: fileNodeId,
    label: "File" as const,
    properties: { path: filePath, relativePath, language },
  };

  const tree = parseTree(source, language);
  if (tree.rootNode.hasError) {
    throw new Error("Syntax error");
  }

  const state = walkJsTsNodes(fileNodeId, tree, language);
  state.nodes.unshift(fileNode);

  const parsed = finalizeLanguageLevel(fileNodeId, tree, state);
  applyFrameworkSemantics(fileNodeId, tree, parsed, state);

  return parsed;
}
