import { applyEdits, getNodeValue, modify, type Node, type ParseError, parseTree } from "jsonc-parser";

export function initJson(text: string, label: string, comments = true): Record<string, unknown> {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: comments, disallowComments: !comments });
  if (errors.length > 0 || root?.type !== "object")
    throw new Error(`${label} must be an object with valid ${comments ? "JSONC" : "JSON"}`);
  const visit = (node: Node): void => {
    if (node.type === "object") {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value as string;
        if (keys.has(key))
          throw new Error(`Duplicate key ${JSON.stringify(key)} in ${label}; reconcile it before setup`);
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return getNodeValue(root) as Record<string, unknown>;
}

export function editInitJson(text: string, path: readonly (string | number)[], value: unknown): string {
  const edits = modify(text, [...path], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" },
  });
  return applyEdits(text, edits);
}
