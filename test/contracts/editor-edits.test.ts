import { describe, it, strict } from "poku";
import { applySourceEdits, assertSqlPreserved, editCases } from "../editor-hub/edit-matrix.mjs";

const range = (start: number, end = start) => ({
  start: { line: 0, character: start },
  end: { line: 0, character: end },
});
await describe("source edit matrix safety", async () => {
  await it("applies independent cross-file edits against original UTF-16/CRLF buffers without mutation", () => {
    const sources = { first: "😀name\r\nnext", second: "name" };
    strict.deepStrictEqual(
      applySourceEdits(sources, {
        first: [{ range: range(2, 6), newText: "renamed" }],
        second: [{ range: range(0, 4), newText: "renamed" }],
      }),
      { first: "😀renamed\r\nnext", second: "renamed" },
    );
    strict.strictEqual(sources.first, "😀name\r\nnext");
  });
  await it("rejects wrong ownership, invalid ranges and ambiguous overlapping edits", () => {
    strict.throws(() => applySourceEdits({ a: "abc" }, { b: [] }), /unexpected/);
    for (const invalid of [range(-1), range(4), range(2, 1)])
      strict.throws(() => applySourceEdits({ a: "abc" }, { a: [{ range: invalid, newText: "x" }] }));
    strict.throws(
      () =>
        applySourceEdits(
          { a: "abc" },
          {
            a: [
              { range: range(0, 2), newText: "x" },
              { range: range(1), newText: "y" },
            ],
          },
        ),
      /overlapping/,
    );
    strict.throws(
      () =>
        applySourceEdits(
          { a: "abc" },
          {
            a: [
              { range: range(0), newText: "x" },
              { range: range(0), newText: "y" },
            ],
          },
        ),
      /ambiguous/,
    );
  });
  await it("requires original SQL and rejects generated overlay text", () => {
    const source = "const q = sql`SELECT value FROM widgets`;";
    assertSqlPreserved(source, source, "SELECT value FROM widgets");
    strict.throws(() => assertSqlPreserved(source, `${source} __typed_sql`, "SELECT value FROM widgets"));
    strict.throws(() => assertSqlPreserved(source, "const q = null;", "SELECT value FROM widgets"));
    strict.deepStrictEqual(editCases, [
      "rename-local",
      "rename-cross-file",
      "format-document",
      "format-range",
      "quick-fix",
    ]);
  });
});
