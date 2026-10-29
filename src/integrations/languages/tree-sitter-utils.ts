import type { SyntaxNode } from "./syntax/tree-sitter.js";

export type CallExpressionParts = {
  expression: string;
  callee: string;
  receiver: string | null;
};

export function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) {
    walk(child, visit);
  }
}

export function walkScoped(
  node: SyntaxNode,
  visit: (node: SyntaxNode) => void,
  shouldSkipChild: (node: SyntaxNode) => boolean,
): void {
  visit(node);

  for (const child of node.namedChildren) {
    if (child.id !== node.id && shouldSkipChild(child)) {
      continue;
    }

    walkScoped(child, visit, shouldSkipChild);
  }
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

  // A chain split over lines (`this.catModel\n  .findById(…)`) leaves line
  // breaks and indentation around its dots and at the end of the receiver.
  const rawReceiver = expression.slice(0, lastDotIndex).replace(/\s*(\??\.)\s*/gu, "$1").trim();
  const receiver = rawReceiver.includes("(") ? stripCallsFromReceiver(rawReceiver) : rawReceiver;

  return {
    expression,
    callee: expression.slice(lastDotIndex + 1),
    receiver,
  };
}

function stripCallsFromReceiver(receiver: string): string {
  const parenIndex = receiver.indexOf("(");
  if (parenIndex === -1) return receiver;
  const base = receiver.slice(0, parenIndex);
  const dotIndex = base.indexOf(".");
  return dotIndex === -1 ? base : base.slice(0, dotIndex);
}
