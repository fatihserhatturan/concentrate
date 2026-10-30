import { fileURLToPath } from "node:url";
import { Language, Parser, type Node, type Tree } from "web-tree-sitter";

// The only module that loads tree-sitter. Grammars are WebAssembly files built
// by `npm run grammars:build` (see vendor/grammars/manifest.json) and run on
// web-tree-sitter, so installing Concentrate never needs a native build.

export type SyntaxNode = Node;
export type SyntaxTree = Tree;
export type GrammarName = "javascript" | "typescript" | "tsx" | "python" | "go" | "rust";

const grammarsDirectory = fileURLToPath(new URL("../../../../vendor/grammars/", import.meta.url));

let runtime: Promise<void> | undefined;
const parsers = new Map<GrammarName, Promise<Parser>>();

function parserFor(grammar: GrammarName): Promise<Parser> {
  let parser = parsers.get(grammar);
  if (!parser) {
    runtime ??= Parser.init();
    parser = runtime
      .then(() => Language.load(`${grammarsDirectory}${grammar}.wasm`))
      .then((language) => new Parser().setLanguage(language));
    parsers.set(grammar, parser);
  }
  return parser;
}

// Parses `source`; the caller owns the tree and must delete() it, since trees
// live in WebAssembly memory that the garbage collector does not reclaim.
export async function parseSyntaxTree(grammar: GrammarName, source: string): Promise<SyntaxTree> {
  const tree = (await parserFor(grammar)).parse(source);
  if (!tree) throw new Error(`tree-sitter could not parse the ${grammar} source`);
  return tree;
}

// Parses `source`, hands the tree to `use` and frees it afterwards.
export async function withSyntaxTree<T>(
  grammar: GrammarName,
  source: string,
  use: (tree: SyntaxTree) => T | Promise<T>,
): Promise<T> {
  const tree = await parseSyntaxTree(grammar, source);
  try {
    return await use(tree);
  } finally {
    tree.delete();
  }
}

// Position of `node` in `nodes`. Node objects are wrappers created on access,
// so identity comparisons do not work; compare ids instead.
export function indexOfNode(nodes: readonly SyntaxNode[], node: SyntaxNode): number {
  return nodes.findIndex((candidate) => candidate.id === node.id);
}
