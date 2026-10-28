import { it, strict } from "poku";
import { postgres } from "../src/index.js";

await it("reports PostgreSQL placeholder occurrences without treating quoted or commented markers as parameters", () => {
  const dialect = postgres();
  const schema = dialect.validateSnapshot({ dialect: "postgres", tables: {} });
  const source = "SELECT '$1', $$ $2 $$, $1, $1 -- $4\n/* $3 */";
  const occurrences = dialect.parameterOccurrences!(source, schema);
  strict.deepStrictEqual(
    occurrences.map(({ index }) => index),
    [1, 1],
  );
  strict.deepStrictEqual(
    occurrences.map(({ range }) => source.slice(range.start, range.end)),
    ["$1", "$1"],
  );
});
