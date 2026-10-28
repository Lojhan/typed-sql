import type { DialectPlugin, SchemaSnapshot } from "@typed-sql/core";
import { strict } from "poku";
import { compileSource } from "../../packages/compiler/src/index.js";

export const fragmentRows = [
  { id: 1n, email: "one@example.test" },
  { id: 2n, email: "two@example.test" },
  { id: 3n, email: "three@example.test" },
  { id: 4n, email: "four@example.test" },
  { id: 5n, email: "five@example.test" },
] as const;

export function fragmentListCases<Query>(
  query: (cardinality: 1 | 2 | 5) => Query,
  expectedText: (cardinality: number) => string,
) {
  return ([1, 2, 5] as const).map((cardinality) => ({
    name: `${cardinality}-rows`,
    cardinality,
    query: query(cardinality),
    expectedText: expectedText(cardinality),
    expectedValues: fragmentRows.slice(0, cardinality).flatMap(({ id, email }) => [id, email]),
  }));
}

/** Shared behavior corpus; each grammar supplies its own snapshot and cast syntax. */
export function assertRepeatedInputInference<Snapshot extends SchemaSnapshot, Policy>(options: {
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly snapshot: Snapshot;
  readonly castType: string;
  readonly castParameterType: "bigint" | "string";
  readonly returningClause?: string;
}): void {
  const ids = `\${ids.map((id) => sql.fragment\`\${id}\`)}`;
  const emails = `\${emails.map((email) => sql.fragment\`\${email}\`)}`;
  const castIds = `\${ids.map((id) => sql.fragment\`CAST(\${id} AS ${options.castType})\`)}`;
  const cases = [
    { sql: `SELECT id, email FROM users WHERE id IN (${ids})`, precise: true, patterns: [["bigint"]] },
    {
      sql: `SELECT id, email FROM users WHERE email IN (\${ids.map(() => sql.fragment\`')'\`)})`,
      precise: true,
      patterns: [[]],
    },
    {
      sql: `SELECT id, email FROM users WHERE id IN (\${ids.map((id) => sql.fragment\`\n  \${id}\n\`)})`,
      precise: true,
      patterns: [["bigint"]],
    },

    {
      sql: `SELECT id, email FROM users WHERE id IN (${castIds})`,
      precise: true,
      patterns: [[options.castParameterType]],
      idsType: options.castParameterType,
    },
    { sql: `SELECT id, email FROM users WHERE NOT (id IN (${ids}))`, precise: true, patterns: [["bigint"]] },
    {
      sql: `SELECT id, email FROM users WHERE id IN (${ids}) AND email IN (${emails})`,
      precise: true,
      patterns: [["bigint"], ["string"]],
    },
    { sql: `SELECT id, email FROM users WHERE id IN (${ids}) OR email IS NULL`, precise: true, patterns: [["bigint"]] },
    {
      sql: `WITH selected AS (SELECT id, email FROM users) SELECT id, email FROM selected WHERE id IN (${ids})`,
      precise: false,
    },
    { sql: `SELECT id, email FROM users WHERE id IN (${ids}) UNION ALL SELECT id, email FROM users`, precise: false },
    {
      sql: `SELECT id, email FROM users WHERE id IN (\${ids.map((id) => sql.fragment\`COALESCE(id, id)\`)})`,
      precise: false,
    },
  ];
  if (options.returningClause !== undefined)
    cases.push({
      sql: `INSERT INTO users (id, email) VALUES \${rows.map((row) => sql.fragment\`(\${row.id}, \${row.email})\`)} ${options.returningClause}`,
      precise: true,
      patterns: [["bigint", "string"]],
    });
  for (const item of cases)
    for (const runtimeMetadata of [false, true]) {
      const source = [
        `import { sql } from "${options.dialect.sqlModule}";`,
        `declare const ids: readonly ${item.idsType ?? "bigint"}[];`,
        "declare const emails: readonly string[];",
        "declare const rows: readonly { readonly id: bigint; readonly email: string }[];",
        `export const query = sql\`${item.sql}\`;`,
      ].join("\n");
      const result = compileSource({ source, dialect: options.dialect, schema: options.snapshot, runtimeMetadata });
      strict.deepEqual(result.diagnostics, [], item.sql);
      const query = result.queries[0]!;
      strict.equal(
        query.rowType,
        item.precise ? '{ "id": bigint; "email": string; }' : '{ "id": unknown | null; "email": unknown | null; }',
        item.sql,
      );
      strict.equal(query.parameterType, "readonly unknown[]");
      strict.deepEqual(
        query.variants[0]!.columns.map(({ name, range }) => ({ name, text: source.slice(range.start, range.end) })),
        [
          { name: "id", text: "id" },
          { name: "email", text: "email" },
        ],
      );
      const artifacts = query.repeatedFragments!;
      strict.ok(artifacts.length > 0);
      for (const [index, artifact] of artifacts.entries()) {
        strict.deepEqual(
          artifact.parameterPattern.map((parameter) => parameter.index),
          Array.from({ length: artifact.parameterPattern.length }, (_, parameter) => parameter + 1),
        );
        if (item.precise)
          strict.deepEqual(
            artifact.parameterPattern.map((parameter) => parameter.tsType),
            item.patterns![index],
          );
        const span = artifact.sourceSpan;
        strict.ok(source.slice(span.start, span.end).includes(".map("));
        const before = source.slice(0, span.start).split("\n");
        strict.equal(span.line, before.length);
        strict.equal(span.column, before.at(-1)!.length + 1);
      }
      if (runtimeMetadata) {
        const columns = query.valuePlanChoices![0]!.plan.columns;
        strict.deepEqual(
          columns.map(({ type, nullable }) => ({ type, nullable })),
          item.precise
            ? [
                { type: "bigint", nullable: false },
                { type: "string", nullable: false },
              ]
            : [
                { type: "unknown", nullable: true },
                { type: "unknown", nullable: true },
              ],
        );
      }
    }
  const missingClose = `SELECT id FROM users WHERE id IN (CAST(${options.dialect.placeholder(1)} AS ${options.castType})`;
  strict.ok(options.dialect.analyze(missingClose, options.snapshot).diagnostics.some(({ code }) => code === "TSQ001"));
  const sql = `SELECT id, email FROM users WHERE id IN (${options.dialect.placeholder(1)})`;
  for (const ranges of [[], [{ start: -1, end: 1 }], [{ start: 0, end: sql.length + 1 }], [{ start: 0.5, end: 2 }]]) {
    const result = options.dialect.analyze(sql, options.snapshot, undefined, { repeatedFragmentRanges: ranges });
    strict.deepEqual(result.diagnostics, []);
    strict.equal(result.repeatedResultShapeStable, undefined);
  }
}
