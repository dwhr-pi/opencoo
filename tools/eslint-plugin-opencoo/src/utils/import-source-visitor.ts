import type { TSESTree } from "@typescript-eslint/utils";

/**
 * Builds the listener object that the three boundary rules share: every
 * way a module source string can land in the AST (static import, static
 * export, dynamic import) routed through one callback. Keeps the rules
 * focused on *which* sources are forbidden, not on walking the tree.
 */
export function importSourceVisitor(
  check: (node: TSESTree.Node, source: string) => void,
) {
  return {
    ImportDeclaration(node: TSESTree.ImportDeclaration): void {
      check(node.source, node.source.value);
    },
    ExportAllDeclaration(node: TSESTree.ExportAllDeclaration): void {
      check(node.source, node.source.value);
    },
    ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration): void {
      if (node.source != null) {
        check(node.source, node.source.value);
      }
    },
    ImportExpression(node: TSESTree.ImportExpression): void {
      if (
        node.source.type === "Literal" &&
        typeof node.source.value === "string"
      ) {
        check(node.source, node.source.value);
      }
    },
  } as const;
}
