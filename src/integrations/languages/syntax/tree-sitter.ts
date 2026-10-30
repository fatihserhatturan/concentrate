import { fileURLToPath } from "node:url";
import { Language, Parser, type Node, type Tree } from "web-tree-sitter";

// The only module that loads tree-sitter. Grammars are WebAssembly files built
// by `npm run grammars:build` (see vendor/grammars/manifest.json) and run on
// web-tree-sitter, so installing Concentrate never needs a native build.

export type SyntaxNode = Node;
export type SyntaxTree = Tree;
export type GrammarName = "javascript" | "typescript" | "tsx" | "html" | "python" | "go" | "rust";

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

// Parses `source` into a tree without syntax errors by leaving out the
// statements that contain them. Each round blanks every statement holding an
// ERROR or MISSING node (all characters but line breaks become spaces, so
// positions stay the same) and parses again: a statement is the nearest node
// whose parent type is in `statementParents`, or, in the last round, the
// nearest child of the root. Returns the tree and the first line of every
// left-out statement; throws when the source cannot be cleaned up.
export async function parseSyntaxTreeSkippingErrors(
  grammar: GrammarName,
  source: string,
  statementParents: ReadonlySet<string>,
  rounds = 4,
): Promise<{ tree: SyntaxTree; skippedLines: number[] }> {
  const skipped = new Set<number>();
  let text = source;
  for (let round = 1; ; round += 1) {
    const tree = await parseSyntaxTree(grammar, text);
    if (!tree.rootNode.hasError) return { tree, skippedLines: [...skipped].sort((a, b) => a - b) };

    const lastRound = round >= rounds;
    const ranges = errorStatementRanges(tree.rootNode, lastRound ? new Set([tree.rootNode.type]) : statementParents);
    tree.delete();
    if (ranges.length === 0) break;
    for (const range of ranges) {
      text = blank(text, range.start, range.end);
      skipped.add(range.line);
    }
    if (lastRound) {
      const last = await parseSyntaxTree(grammar, text);
      if (!last.rootNode.hasError) return { tree: last, skippedLines: [...skipped].sort((a, b) => a - b) };
      last.delete();
      break;
    }
  }
  throw new Error("Syntax error");
}

function errorStatementRanges(root: SyntaxNode, statementParents: ReadonlySet<string>): Array<{ start: number; end: number; line: number }> {
  const ranges = new Map<number, { start: number; end: number; line: number }>();
  const visit = (node: SyntaxNode) => {
    if (node.isError || node.isMissing) {
      let statement = node;
      while (statement.parent && !statementParents.has(statement.parent.type)) statement = statement.parent;
      // An error whose only enclosing statement is the root cannot be left out.
      if (statement.parent) {
        ranges.set(statement.startIndex, { start: statement.startIndex, end: statement.endIndex, line: statement.startPosition.row + 1 });
      }
      return;
    }
    for (const child of node.children) {
      if (child.hasError || child.isMissing) visit(child);
    }
  };
  visit(root);
  return [...ranges.values()];
}

function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + text.slice(start, end).replace(/[^\r\n]/gu, " ") + text.slice(end);
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
