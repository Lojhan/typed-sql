/** Add SQL features without narrowing the upstream TypeScript LSP contract. */
export function extendTypeScriptCapabilities(value: unknown): Record<string, unknown> {
  const upstream = options(value);
  const completion = options(upstream.completionProvider);
  const actions = options(upstream.codeActionProvider);
  return {
    ...upstream,
    completionProvider: {
      ...completion,
      triggerCharacters: [...new Set([...strings(completion.triggerCharacters), "."])],
    },
    definitionProvider: upstream.definitionProvider || true,
    codeActionProvider:
      Object.keys(actions).length === 0
        ? true
        : {
            ...actions,
            // An omitted list means all kinds; do not narrow that to quickfix.
            ...(Array.isArray(actions.codeActionKinds)
              ? { codeActionKinds: [...new Set([...strings(actions.codeActionKinds), "quickfix"])] }
              : {}),
          },
  };
}

function options(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
