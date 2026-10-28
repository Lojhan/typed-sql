import { it, strict } from "poku";
import { sqlite } from "../src/index.js";

await it("reports ordered SQLite placeholders and ignores quoted or commented markers", () => {
  const dialect = sqlite();
  const schema = dialect.validateSnapshot({ formatVersion: 1, dialect: "sqlite", tables: {} });
  const source = "SELECT '?', ?, ? -- ?\n/* ? */";
  const occurrences = dialect.parameterOccurrences!(source, schema);
  strict.deepStrictEqual(
    occurrences.map(({ index }) => index),
    [1, 2],
  );
  strict.deepStrictEqual(
    occurrences.map(({ range }) => source.slice(range.start, range.end)),
    ["?", "?"],
  );
});
