import { assertFragmentListConformance, assertGrammarConformance } from "@typed-sql/conformance";
import { runAdaptedGrammarConformanceV1 } from "@typed-sql/conformance/v2";
import { sql, synthetic } from "@typed-sql/example-synthetic-grammar";
import { syntheticConformanceFixture, syntheticSnapshot } from "@typed-sql/example-synthetic-grammar/conformance";
import { describe, it, strict } from "poku";

await describe("synthetic third-party grammar", async () => {
  await it("passes through published typed-sql entrypoints only", () => {
    const report = assertGrammarConformance(syntheticConformanceFixture);
    strict.strictEqual(report.grammar, "synthetic");
    strict.strictEqual(report.structuralVariants, 2);
    strict.strictEqual(
      runAdaptedGrammarConformanceV1(syntheticConformanceFixture).every(({ status }) => status === "pass"),
      true,
    );
  });

  await it("proves implicit fragment lists through public third-party contracts", () => {
    const rows = [
      { value: 1, label: "one" },
      { value: 2, label: "two" },
      { value: 3, label: "three" },
      { value: 4, label: "four" },
      { value: 5, label: "five" },
    ] as const;
    const query = (cardinality: 1 | 2 | 5) =>
      sql`INSERT INTO widgets (value, label) VALUES ${rows
        .slice(0, cardinality)
        .map((row) => sql.fragment`(${row.value}, ${row.label})`)}`;
    const text = (cardinality: number) =>
      `INSERT INTO widgets (value, label) VALUES ${Array.from(
        { length: cardinality },
        (_, index) => `(?${index * 2 + 1}, ?${index * 2 + 2})`,
      ).join(", ")}`;
    const compilerSource = [
      'import { sql } from "@typed-sql/example-synthetic-grammar";',
      "declare const rows: readonly { readonly value: number; readonly label: string | null }[];",
      "sql`INSERT INTO widgets (value, label) VALUES ${rows.map((row) => sql.fragment`(${row.value}, ${row.label})`)}`;",
    ].join("\n");
    const dialect = synthetic();
    const report = assertFragmentListConformance({
      name: "synthetic.fragment-list.insert",
      dialect,
      renderer: dialect,
      snapshot: syntheticSnapshot,
      compilerSource,
      expectedRepresentativeSql: text(2),
      expectedRowType: "never",
      expectedResultKind: "command",
      expectedElementParameters: [
        { index: 1, tsType: "number", nullable: false, databaseType: "scalar" },
        { index: 2, tsType: "string | null", nullable: true, databaseType: "text" },
      ],
      renderCases: ([1, 2, 5] as const).map((cardinality) => ({
        name: `${cardinality}-rows`,
        cardinality,
        query: query(cardinality),
        expectedText: text(cardinality),
        expectedValues: rows.slice(0, cardinality).flatMap(({ value, label }) => [value, label]),
      })),
      diagnostics: [
        {
          name: "row-arity",
          source: compilerSource.replace("(${row.value}, ${row.label})", "(${row.value})"),
          diagnosticCode: "SYN001",
        },
      ],
    });
    strict.strictEqual(report.grammar, "synthetic");
  });
});
