import { describe, it, strict } from "poku";
import { mapProtocolCoordinates } from "../src/protocol-mapping.js";
import { ResolveContexts } from "../src/resolve-context.js";

await describe("upstream resolve context", async () => {
  await it("restores opaque data and the exact source snapshot across all resolve routes", () => {
    const cache = new ResolveContexts<object>();
    const state = { version: 42 };
    const data = { position: 900, nested: { line: 500, character: 2 } };
    for (const [request, resolve] of [
      ["textDocument/completion", "completionItem/resolve"],
      ["textDocument/codeAction", "codeAction/resolve"],
      ["textDocument/inlayHint", "inlayHint/resolve"],
      ["textDocument/codeLens", "codeLens/resolve"],
    ]) {
      const input = { label: "item", data };
      const [wrapped] = cache.response(request!, [input], "file:///one.ts", state) as unknown[];
      const restored = cache.restore(wrapped, resolve!);
      strict.deepStrictEqual(restored.item, input);
      strict.strictEqual((restored.item as typeof input).data, data);
      strict.strictEqual(restored.context?.state, state);
      strict.strictEqual(restored.context?.uri, "file:///one.ts");
      strict.strictEqual(cache.restore(wrapped, "other/resolve").expired, true);
    }
  });

  await it("preserves missing, null and default completion data", () => {
    const cache = new ResolveContexts<number>();
    const response = cache.response(
      "textDocument/completion",
      {
        isIncomplete: true,
        itemDefaults: { data: { offset: 123 }, commitCharacters: ["."] },
        items: [{ label: "inherited" }, { label: "null", data: null }],
      },
      "one",
      1,
    ) as { items: unknown[]; isIncomplete: boolean; itemDefaults: unknown };
    strict.strictEqual(response.isIncomplete, true);
    strict.deepStrictEqual(response.itemDefaults, { data: { offset: 123 }, commitCharacters: ["."] });
    strict.deepStrictEqual(cache.restore(response.items[0], "completionItem/resolve").item, {
      label: "inherited",
      data: { offset: 123 },
    });
    strict.deepStrictEqual(cache.restore(response.items[1], "completionItem/resolve").item, {
      label: "null",
      data: null,
    });
    const [missing] = cache.wrap([{ label: "missing" }], "completionItem/resolve", "one", 1);
    strict.deepStrictEqual(cache.restore(missing, "completionItem/resolve").item, { label: "missing" });
    strict.deepStrictEqual(cache.restore({ data: { producer: true } }, "completionItem/resolve"), {
      item: { data: { producer: true } },
    });
    strict.strictEqual(cache.response("textDocument/hover", null, "one", 1), null);
  });

  await it("bounds batches and expires closed or evicted identities", () => {
    const cache = new ResolveContexts<number>(2);
    const [first] = cache.wrap([{ label: "a" }, { label: "b" }], "completionItem/resolve", "one", 1);
    const [second] = cache.wrap([{}], "completionItem/resolve", "two", 2);
    strict.strictEqual(cache.restore(first, "completionItem/resolve").context?.state, 1);
    cache.wrap([{}], "completionItem/resolve", "three", 3);
    strict.strictEqual(cache.restore(first, "completionItem/resolve").expired, true);
    cache.delete("two");
    strict.strictEqual(cache.restore(second, "completionItem/resolve").expired, true);
    strict.throws(() => new ResolveContexts(0), /positive/u);
  });

  await it("uses restored ownership for edit-bearing results without interpreting producer data", () => {
    const cache = new ResolveContexts<number>();
    const data = { fileName: "opaque", position: 900 };
    const [wrapped] = cache.wrap([{ label: "x", data }], "completionItem/resolve", "one", 7);
    const restored = cache.restore(wrapped, "completionItem/resolve");
    const mapped = mapProtocolCoordinates(
      {
        data,
        additionalTextEdits: [
          { range: { start: { line: 2, character: 10 }, end: { line: 2, character: 12 } }, newText: "x" },
        ],
      },
      {
        lookup: () => undefined,
        position: (shift: number, position) => ({ ...position, character: position.character - shift }),
      },
      restored.context?.state,
    ) as { data: unknown; additionalTextEdits: { range: unknown }[] };
    strict.strictEqual(mapped.data, data);
    strict.deepStrictEqual(mapped.additionalTextEdits[0]?.range, {
      start: { line: 2, character: 3 },
      end: { line: 2, character: 5 },
    });
  });
});
