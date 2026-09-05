import { describe, it, strict } from "poku";
import { projectSemanticTokens, SemanticTokenResults } from "../src/semantic-tokens.js";

interface Response {
  resultId?: string;
  data?: number[];
  edits?: { start: number; deleteCount: number; data: number[] }[];
}

await describe("source semantic tokens", async () => {
  await it("removes generated tokens and re-encodes line and character deltas", () => {
    const data = [0, 0, 2, 1, 0, 0, 3, 4, 2, 1, 0, 5, 2, 3, 0, 1, 2, 1, 4, 0];
    const projected = projectSemanticTokens(data, (token) => {
      if (token.line === 0 && token.character === 3) return undefined;
      return { ...token, character: token.line === 0 && token.character >= 7 ? token.character - 4 : token.character };
    });
    strict.deepStrictEqual(projected, [0, 0, 2, 1, 0, 0, 4, 2, 3, 0, 1, 2, 1, 4, 0]);
    strict.strictEqual(data.length, 20);
    strict.deepStrictEqual(
      projectSemanticTokens([0, 0, 4, 1, 0], (token) => ({ ...token, length: 0 })),
      [],
    );
    strict.deepStrictEqual(
      projectSemanticTokens(data, (token) => token),
      data,
    );
  });

  await it("rejects malformed upstream data and reversed projections", () => {
    for (const data of [null, [0], [0, 0, -1, 0, 0], [0, 0, 1.5, 0, 0]]) {
      strict.throws(() => projectSemanticTokens(data, (token) => token), /Invalid upstream/u);
    }
    strict.throws(
      () => projectSemanticTokens([0, 1, 1, 0, 0], (token) => ({ ...token, character: -1 })),
      /not source ordered/u,
    );
  });

  await it("reconstructs changed arrays and returns an empty delta for unchanged data", () => {
    const cache = new SemanticTokenResults();
    const before = [0, 1, 2, 0, 0];
    const first = cache.response("one", before) as Response;
    const unchanged = cache.response("one", before, first.resultId) as Response;
    strict.deepStrictEqual(unchanged.edits, []);
    const after = [1, 1, 2, 0, 0, 0, 4, 3, 1, 0];
    const changed = cache.response("one", after, unchanged.resultId) as Response;
    const reconstructed = [...before];
    for (const edit of changed.edits ?? []) reconstructed.splice(edit.start, edit.deleteCount, ...edit.data);
    strict.deepStrictEqual(reconstructed, after);
    const removed = cache.response("one", [], changed.resultId) as Response;
    strict.deepStrictEqual(removed.edits, [{ start: 0, deleteCount: after.length, data: [] }]);
  });

  await it("falls back to full results for unknown, closed or evicted identities", () => {
    const cache = new SemanticTokenResults(2, 10);
    const data = [0, 0, 1, 0, 0];
    const first = cache.response("one", data) as Response;
    strict.deepStrictEqual((cache.response("two", data, first.resultId) as Response).data, data);
    cache.response("three", data);
    strict.deepStrictEqual((cache.response("one", data, first.resultId) as Response).data, data);
    const current = cache.response("one", data) as Response;
    cache.delete("one");
    strict.deepStrictEqual((cache.response("one", data, current.resultId) as Response).data, data);
    const oversized = [...data, ...data, ...data];
    strict.deepStrictEqual(cache.response("large", oversized), { data: oversized });
  });
});
