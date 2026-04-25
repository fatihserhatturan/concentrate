import type Parser from "tree-sitter";

export type CallExpressionParts = {
  expression: string;
  callee: string;
  receiver: string | null;
};

export function walk(node: Parser.SyntaxNode, visit: (node: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) {
    walk(child, visit);
  }
}

export function walkScoped(
  node: Parser.SyntaxNode,
  visit: (node: Parser.SyntaxNode) => void,
  shouldSkipChild: (node: Parser.SyntaxNode) => boolean,
): void {
  visit(node);

  for (const child of node.namedChildren) {
    if (child !== node && shouldSkipChild(child)) {
      continue;
    }

    walkScoped(child, visit, shouldSkipChild);
  }
}

export function createTreeSitterInput(source: string): (offset: number) => string {
  const chunkSize = 16 * 1024;
  return (offset: number) => source.slice(offset, offset + chunkSize);
}

export function analyzeMemberCallExpression(expression: string | undefined): CallExpressionParts | null {
  if (!expression) {
    return null;
  }

  const lastDotIndex = expression.lastIndexOf(".");
  if (lastDotIndex === -1) {
    return {
      expression,
      callee: expression,
      receiver: null,
    };
  }

  return {
    expression,
    callee: expression.slice(lastDotIndex + 1),
    receiver: expression.slice(0, lastDotIndex),
  };
}
