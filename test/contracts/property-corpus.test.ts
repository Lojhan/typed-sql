import { describe, it, strict } from "poku";
import { renderQuery, type SqlRenderer, sql } from "../../packages/core/src/index.js";
import { canonicalizeSchemaValue } from "../../packages/schema/src/index.js";
import { deterministicStrings, FUZZ_SEEDS, sqlFuzzRegressions } from "../fuzz/corpus.js";

const renderer: SqlRenderer = {
  placeholder: (index) => `$${index}`,
  quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
};

await describe("shared deterministic property corpus", async () => {
  await it("keeps generators deterministic and retained regression identifiers unique", () => {
    strict.deepStrictEqual(deterministicStrings(FUZZ_SEEDS.sql, 100), deterministicStrings(FUZZ_SEEDS.sql, 100));
    strict.strictEqual(new Set(sqlFuzzRegressions.map(({ id }) => id)).size, sqlFuzzRegressions.length);
    for (const fixture of sqlFuzzRegressions) {
      strict.ok(fixture.source.length > 0 && fixture.reason.length > 0 && fixture.targets.length > 0);
    }
  });

  await it("keeps implicit fragment lists equivalent to explicit joins across generated cardinalities", () => {
    const values = deterministicStrings(FUZZ_SEEDS.rendering, 256, { alphabet: "abc123", maximumLength: 24 });
    for (const cardinality of [1, 2, 5, 31, 256]) {
      const selected = values.slice(0, cardinality);
      const fragments = selected.map((value, index) => sql.fragment`(${index}, ${value})`);
      const implicit = renderQuery(sql`VALUES ${fragments}`, renderer);
      const explicit = renderQuery(sql`VALUES ${sql.join(fragments, sql.fragment`, `)}`, renderer);
      strict.deepStrictEqual(implicit, explicit);
      strict.deepStrictEqual(
        implicit.values,
        fragments.flatMap((_fragment, index) => [index, selected[index]]),
      );
      strict.strictEqual((implicit.text.match(/\$\d+/gu) ?? []).length, cardinality * 2);
      strict.ok(Object.isFrozen(implicit.values));
    }
  });

  await it("canonicalizes generated schema-shaped values idempotently", () => {
    const names = deterministicStrings(FUZZ_SEEDS.schema, 128, { alphabet: "abcdef", maximumLength: 12 });
    const input = Object.fromEntries(
      names.map((name, index) => [`${name}_${index}`, { z: index, a: [name, { y: false, b: null }] }]),
    );
    const once = canonicalizeSchemaValue(input);
    const twice = canonicalizeSchemaValue(once);
    strict.deepStrictEqual(once, twice);
    strict.strictEqual(JSON.stringify(once), JSON.stringify(twice));
  });
});
