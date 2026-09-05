import { describe, it, strict } from "poku";
import { extractAppendFragments, extractDynamicQueries } from "../src/scanner.js";

await describe("shared code-identifier traversal", async () => {
  await it("ignores quoted and commented calls, retaining aliases and exact dynamic spans", () => {
    const source = [
      'import { sql as q } from "@typed-sql/core";',
      '"q.dynamic(ignored)";',
      "'q.dynamic(ignored)';",
      "`q.dynamic(ignored)`;",
      "// q.dynamic(ignored)",
      "/* q.dynamic(ignored) */",
      'q /* gap */ . dynamic /* gap */ ("actual");',
      "q.dynamic(",
    ].join("\n");
    const found = extractDynamicQueries(source);
    strict.strictEqual(found.length, 2);
    strict.strictEqual(
      source.slice(found[0]!.range.start, found[0]!.range.end),
      'q /* gap */ . dynamic /* gap */ ("actual")',
    );
    strict.strictEqual(source.slice(found[1]!.range.start, found[1]!.range.end), "q.dynamic");
    strict.deepStrictEqual(extractDynamicQueries(source), found);
  });

  await it("keeps append-specific incomplete-call behavior and fragment ranges", () => {
    const source = [
      'import { sql } from "@typed-sql/core";',
      "const base = sql`SELECT 1`;",
      '"sql.append(base, ignored)"; /* sql.append(base, ignored) */',
      "sql /* gap */ .append(base, sql.fragment` WHERE TRUE`);",
      "sql.append(base",
    ].join("\n");
    const found = extractAppendFragments(source, (index) => `$${index}`);
    strict.strictEqual(found.length, 1);
    strict.strictEqual(found[0]!.fragment.sql, " WHERE TRUE");
    const range = found[0]!.fragment.range;
    strict.strictEqual(source.slice(range.start, range.end), "sql.fragment` WHERE TRUE`");
    strict.deepStrictEqual(
      extractAppendFragments(source, (index) => `$${index}`),
      found,
    );
  });
});
