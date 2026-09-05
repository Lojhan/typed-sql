const marker = "typed-sql/resolve/v1";
const resolveMethods = new Map([
  ["textDocument/completion", "completionItem/resolve"],
  ["textDocument/codeAction", "codeAction/resolve"],
  ["textDocument/inlayHint", "inlayHint/resolve"],
  ["textDocument/codeLens", "codeLens/resolve"],
]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Context<State> {
  readonly state: State;
  readonly uri: string;
  readonly method: string;
}

/** One bounded identity per result batch; upstream data stays opaque on the wire. */
export class ResolveContexts<State> {
  readonly #entries = new Map<string, Context<State>>();
  #sequence = 0;

  constructor(readonly limit = 256) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("Resolve context limit must be positive");
  }

  response(method: string, result: unknown, uri: string, state: State): unknown {
    const resolveMethod = resolveMethodFor(method);
    if (resolveMethod === undefined) return result;
    if (Array.isArray(result)) return this.wrap(result, resolveMethod, uri, state);
    if (method === "textDocument/completion" && object(result) && Array.isArray(result.items)) {
      const defaults = object(result.itemDefaults) ? result.itemDefaults : undefined;
      const items = result.items.map((item: unknown) =>
        object(item) && !Object.hasOwn(item, "data") && defaults !== undefined && Object.hasOwn(defaults, "data")
          ? { ...item, data: defaults.data }
          : item,
      );
      return { ...result, items: this.wrap(items, resolveMethod, uri, state) };
    }
    return result;
  }

  wrap(items: readonly unknown[], method: string, uri: string, state: State): unknown[] {
    if (items.length === 0) return [];
    while (this.#entries.size >= this.limit) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    const id = String(++this.#sequence);
    this.#entries.set(id, { method, uri, state });
    return items.map((item) =>
      !object(item)
        ? item
        : {
            ...item,
            data: { kind: marker, id, hasData: Object.hasOwn(item, "data"), upstream: item.data },
          },
    );
  }

  restore(item: unknown, method: string): { item: unknown; context?: Context<State>; expired?: true } {
    if (!object(item) || !object(item.data) || item.data.kind !== marker) return { item };
    const context = typeof item.data.id === "string" ? this.#entries.get(item.data.id) : undefined;
    if (context === undefined || context.method !== method) return { item, expired: true };
    const { data, ...rest } = item;
    return { item: data.hasData === true ? { ...rest, data: data.upstream } : rest, context };
  }

  delete(uri: string): void {
    for (const [id, context] of this.#entries) if (context.uri === uri) this.#entries.delete(id);
  }
}

export function resolveMethodFor(method: string): string | undefined {
  return resolveMethods.get(method);
}
