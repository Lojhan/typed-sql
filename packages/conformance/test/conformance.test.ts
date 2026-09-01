import { describe, it, strict } from "poku";
import { mysql, sql as mysqlSql, typePolicy as mysqlTypePolicy } from "../../mysql/src/index.js";
import { mysqlRenderer } from "../../mysql/src/runtime.js";
import { postgres, sql as postgresSql, typePolicy as postgresTypePolicy } from "../../postgres/src/index.js";
import { postgresRenderer } from "../../postgres/src/runtime.js";
import {
  assertCodecConformance,
  assertGrammarConformance,
  assertRuntimeAdapterConformance,
  assertVersionedCapabilityConformance,
  defineCodecConformanceFixture,
  defineGrammarConformanceFixture,
  GRAMMAR_CONFORMANCE_VERSION,
  type GrammarAnalysisProbe,
  type GrammarSemanticExpectation,
  measureGrammarPerformance,
} from "../src/index.js";
import { runAdaptedGrammarConformanceV1 } from "../src/v2/index.js";

const postgresSnapshot = {
  formatVersion: 1,
  dialect: "postgres",
  dialectVersion: "1.0.0",
  tables: {
    widgets: {
      name: "widgets",
      columns: {
        value: { name: "value", databaseType: "bigint", tsType: "bigint", nullable: false },
        label: { name: "label", databaseType: "text", tsType: "string", nullable: true },
      },
    },
    categories: {
      name: "categories",
      columns: {
        widget_value: { name: "widget_value", databaseType: "bigint", tsType: "bigint", nullable: false },
        label: { name: "label", databaseType: "text", tsType: "string", nullable: false },
      },
    },
  },
} as const;

const mysqlSnapshot = { ...postgresSnapshot, dialect: "mysql" } as const;

const read = (
  capabilities: readonly string[] = [],
  maximum: GrammarSemanticExpectation["cardinalityMaximum"] = "many",
): GrammarSemanticExpectation => ({
  operation: "read",
  volatility: "stable",
  cardinalityMaximum: maximum,
  capabilities,
});

const write = (maximum: GrammarSemanticExpectation["cardinalityMaximum"]): GrammarSemanticExpectation => ({
  operation: "write",
  volatility: "volatile",
  cardinalityMaximum: maximum,
});

const probe = (
  sql: string,
  expectedRowType: string,
  expectedParameterType = "readonly []",
  expectedSemantics: GrammarSemanticExpectation = read(),
  expectedResultKind: "rows" | "command" = "rows",
): GrammarAnalysisProbe => ({
  sql,
  parameterCount: expectedParameterType === "readonly []" ? 0 : expectedParameterType.split(",").length,
  expectedRowType,
  expectedParameterType,
  expectedResultKind,
  expectedSemantics,
});

const postgresDialect = postgres();
const mysqlDialect = mysql();

function diagnoseConformance<Fixture>(run: () => Fixture): Fixture {
  try {
    return run();
  } catch (error) {
    console.error(error);
    throw error;
  }
}

await describe("public grammar conformance package", async () => {
  await it("verifies version, pre-release, and setting capability boundaries", () => {
    assertVersionedCapabilityConformance({
      dialect: postgres(),
      probes: [
        {
          name: "before-supported-major",
          snapshot: {
            ...postgresSnapshot,
            server: {
              product: "postgres",
              version: "13.9",
              versionKey: "13",
              features: [],
              settings: { standardConformingStrings: "on" },
            },
          },
          expected: [{ capability: "returning", level: "conservative", diagnostic: "TSQ403" }],
        },
        {
          name: "at-supported-major",
          snapshot: {
            ...postgresSnapshot,
            server: {
              product: "postgres",
              version: "14.0",
              versionKey: "14",
              features: [],
              settings: { standardConformingStrings: "on" },
            },
          },
          expected: [
            {
              capability: "returning",
              level: "exact",
              evidenceKinds: ["grammar", "policy", "server-version", "setting"],
            },
          ],
        },
        {
          name: "ambiguous-setting",
          snapshot: {
            ...postgresSnapshot,
            server: {
              product: "postgres",
              version: "18.6",
              versionKey: "18",
              features: [],
              settings: { standardConformingStrings: "off" },
            },
          },
          expected: [{ capability: "returning", level: "conservative", diagnostic: "TSQ407" }],
        },
        {
          name: "pre-release",
          snapshot: {
            ...postgresSnapshot,
            server: {
              product: "postgres",
              version: "19beta1",
              versionKey: "19",
              features: [],
              settings: { standardConformingStrings: "on" },
            },
          },
          expected: [{ capability: "returning", level: "conservative", diagnostic: "TSQ403" }],
        },
      ],
    });

    assertVersionedCapabilityConformance({
      dialect: mysql(),
      probes: [
        {
          name: "safe-sql-mode",
          snapshot: {
            ...mysqlSnapshot,
            server: {
              product: "mysql",
              version: "8.4.0",
              versionKey: "8.4.0",
              features: [],
              settings: { sqlMode: "STRICT_TRANS_TABLES" },
            },
          },
          expected: [{ capability: "lockingReads", level: "exact" }],
        },
        {
          name: "syntax-changing-sql-mode",
          snapshot: {
            ...mysqlSnapshot,
            server: {
              product: "mysql",
              version: "8.4.0",
              versionKey: "8.4.0",
              features: [],
              settings: { sqlMode: "ANSI_QUOTES" },
            },
          },
          expected: [{ capability: "lockingReads", level: "conservative", diagnostic: "TSQ407" }],
        },
      ],
    });
  });

  await it("holds PostgreSQL to every required and declared capability contract", () => {
    const fixture = defineGrammarConformanceFixture({
      version: GRAMMAR_CONFORMANCE_VERSION,
      name: "postgres",
      dialect: postgresDialect,
      renderer: postgresRenderer,
      snapshot: postgresSnapshot,
      placeholderTwo: "$2",
      identifier: 'account"status',
      quotedIdentifier: '"account""status"',
      probes: {
        select: {
          ...probe("SELECT value FROM widgets", '{ "value": bigint; }'),
          expectedSemantics: {
            ...read(),
            dependencies: [
              { kind: "relation", access: "read", name: "widgets" },
              { kind: "column", access: "read", name: "value" },
            ],
          },
        },
        parameters: probe("SELECT value FROM widgets WHERE value = $1", '{ "value": bigint; }', "readonly [bigint]"),
        nullability: probe("SELECT label FROM widgets", '{ "label": string | null; }'),
        joins: probe(
          "SELECT widget.value, category.label AS category_label FROM widgets widget LEFT JOIN categories category ON category.widget_value = widget.value",
          '{ "value": bigint; "category_label": string | null; }',
        ),
        ctes: probe(
          "WITH picked AS (SELECT value FROM widgets WHERE value = $1) SELECT value FROM picked",
          '{ "value": bigint; }',
          "readonly [bigint]",
          read(["ctes"]),
        ),
        functions: probe("SELECT COUNT(*) AS total FROM widgets", '{ "total": bigint; }'),
        dml: probe(
          "UPDATE widgets SET label = $1 WHERE value = $2 RETURNING value",
          '{ "value": bigint; }',
          "readonly [string | null, bigint]",
          write("many"),
        ),
      },
      capabilities: [
        {
          capability: "aggregateFilter",
          supported: true,
          analysis: probe(
            "SELECT COUNT(*) FILTER (WHERE value > 0) AS total FROM widgets",
            '{ "total": bigint; }',
            "readonly []",
            read(["aggregateFilter"]),
          ),
        },
        {
          capability: "arrays",
          supported: true,
          analysis: probe(
            "SELECT ARRAY[1, 2] AS items FROM widgets",
            '{ "items": readonly (number)[]; }',
            "readonly []",
            read(["arrays"]),
          ),
        },
        {
          capability: "distinctOn",
          supported: true,
          analysis: probe(
            "SELECT DISTINCT ON (value) value FROM widgets",
            '{ "value": bigint; }',
            "readonly []",
            read(["distinctOn"]),
          ),
        },
        {
          capability: "fullJoins",
          supported: true,
          analysis: probe(
            "SELECT widget.value, category.label AS category_label FROM widgets widget FULL JOIN categories category ON category.widget_value = widget.value",
            '{ "value": bigint | null; "category_label": string | null; }',
            "readonly []",
            read(["fullJoins"]),
          ),
        },
        {
          capability: "lockingReads",
          supported: true,
          analysis: probe("SELECT value FROM widgets FOR UPDATE", '{ "value": bigint; }', "readonly []", {
            ...read(["lockingReads"]),
            locking: "row",
            connectionAffinity: "transaction",
          }),
        },
        {
          capability: "recursiveCtes",
          supported: false,
          unsupported: {
            sql: "WITH RECURSIVE picked(value) AS (SELECT value FROM widgets) SELECT value FROM picked",
            diagnosticCode: "TSQ210",
          },
        },
        {
          capability: "returning",
          supported: true,
          analysis: probe(
            "DELETE FROM widgets WHERE value = $1 RETURNING value",
            '{ "value": bigint; }',
            "readonly [bigint]",
            { ...write("many"), capabilities: ["returning"] },
          ),
        },
        {
          capability: "setOperations",
          supported: false,
          unsupported: {
            sql: "SELECT value FROM widgets UNION SELECT value FROM widgets",
            diagnosticCode: "TSQ401",
          },
        },
      ],
      unsupported: { sql: "SELECT value FROM missing", diagnosticCode: "TSQ100" },
      structural: {
        source: [
          'import { sql } from "@typed-sql/postgres";',
          "interface Selection { readonly label: boolean }",
          "export function widgets<const Select extends Selection>(select: Select) {",
          "  return sql`SELECT widget.value${select.label ? sql.fragment`, widget.label` : sql.empty} FROM widgets widget`;",
          "}",
        ].join("\n"),
        expectedVariantCount: 2,
        expectedRowType:
          'Select["label"] extends true ? { "value": bigint; "label": string | null; } : Select["label"] extends false ? { "value": bigint; } : { "value": bigint; "label": string | null; } | { "value": bigint; }',
        expectedParameterType: "readonly []",
        expectedSemantics: read(),
      },
      policy: {
        sql: "SELECT CAST(1 AS bigint) AS value",
        policy: { ...postgresTypePolicy, bigint: "string" },
        parameterCount: 0,
        expectedRowType: '{ "value": string; }',
      },
    });
    const report = diagnoseConformance(() => assertGrammarConformance(fixture));
    strict.strictEqual(report.grammar, "postgres");
    strict.strictEqual(report.structuralVariants, 2);
    strict.strictEqual(
      runAdaptedGrammarConformanceV1(fixture).every(({ status }) => status === "pass"),
      true,
    );
  });

  await it("holds MySQL to the same required contract and explicit unsupported capabilities", () => {
    const fixture = defineGrammarConformanceFixture({
      version: GRAMMAR_CONFORMANCE_VERSION,
      name: "mysql",
      dialect: mysqlDialect,
      renderer: mysqlRenderer,
      snapshot: mysqlSnapshot,
      placeholderTwo: "?",
      identifier: "account`status",
      quotedIdentifier: "`account``status`",
      probes: {
        select: probe("SELECT value FROM widgets", '{ "value": bigint; }'),
        parameters: probe("SELECT value FROM widgets WHERE value = ?", '{ "value": bigint; }', "readonly [bigint]"),
        nullability: probe("SELECT label FROM widgets", '{ "label": string | null; }'),
        joins: probe(
          "SELECT widget.value, category.label AS category_label FROM widgets widget LEFT JOIN categories category ON category.widget_value = widget.value",
          '{ "value": bigint; "category_label": string | null; }',
        ),
        ctes: probe(
          "WITH picked AS (SELECT value FROM widgets WHERE value = ?) SELECT value FROM picked",
          '{ "value": bigint; }',
          "readonly [bigint]",
          read(["ctes"]),
        ),
        functions: probe("SELECT COUNT(*) AS total FROM widgets", '{ "total": bigint; }'),
        dml: probe(
          "UPDATE widgets SET label = ? WHERE value = ?",
          "{  }",
          "readonly [string | null, bigint]",
          write(0),
          "command",
        ),
      },
      capabilities: [
        {
          capability: "aggregateFilter",
          supported: false,
          unsupported: {
            sql: "SELECT COUNT(*) FILTER (WHERE value > 0) AS total FROM widgets",
            diagnosticCode: "TSQ001",
          },
        },
        {
          capability: "arrays",
          supported: false,
          unsupported: { sql: "SELECT ARRAY[1] AS items FROM widgets", diagnosticCode: "TSQ401" },
        },
        {
          capability: "distinctOn",
          supported: false,
          unsupported: { sql: "SELECT DISTINCT ON (value) value FROM widgets", diagnosticCode: "TSQ401" },
        },
        {
          capability: "fullJoins",
          supported: false,
          unsupported: {
            sql: "SELECT widget.value FROM widgets widget FULL JOIN categories category ON category.widget_value = widget.value",
            diagnosticCode: "TSQ401",
          },
        },
        {
          capability: "lockingReads",
          supported: true,
          analysis: probe("SELECT value FROM widgets FOR UPDATE", '{ "value": bigint; }', "readonly []", {
            ...read(["lockingReads"]),
            locking: "row",
            connectionAffinity: "transaction",
          }),
        },
        {
          capability: "recursiveCtes",
          supported: false,
          unsupported: {
            sql: "WITH RECURSIVE picked(value) AS (SELECT value FROM widgets) SELECT value FROM picked",
            diagnosticCode: "TSQ401",
          },
        },
        {
          capability: "returning",
          supported: false,
          unsupported: {
            sql: "DELETE FROM widgets WHERE value = ? RETURNING value",
            diagnosticCode: "TSQ401",
          },
        },
        {
          capability: "setOperations",
          supported: false,
          unsupported: {
            sql: "SELECT value FROM widgets UNION SELECT value FROM widgets",
            diagnosticCode: "TSQ401",
          },
        },
      ],
      unsupported: { sql: "SELECT value FROM missing", diagnosticCode: "TSQ100" },
      structural: {
        source: [
          'import { sql } from "@typed-sql/mysql";',
          "interface Selection { readonly label: boolean }",
          "export function widgets<const Select extends Selection>(select: Select) {",
          "  return sql`SELECT widget.value${select.label ? sql.fragment`, widget.label` : sql.empty} FROM widgets widget`;",
          "}",
        ].join("\n"),
        expectedVariantCount: 2,
        expectedRowType:
          'Select["label"] extends true ? { "value": bigint; "label": string | null; } : Select["label"] extends false ? { "value": bigint; } : { "value": bigint; "label": string | null; } | { "value": bigint; }',
        expectedParameterType: "readonly []",
        expectedSemantics: read(),
      },
      policy: {
        sql: "SELECT CAST(1 AS DECIMAL) AS value",
        policy: { ...mysqlTypePolicy, decimal: "number" },
        parameterCount: 0,
        expectedRowType: '{ "value": number; }',
      },
    });
    const report = diagnoseConformance(() => assertGrammarConformance(fixture));
    strict.strictEqual(report.grammar, "mysql");
    strict.strictEqual(report.capabilities.returning, false);
    strict.strictEqual(
      runAdaptedGrammarConformanceV1(fixture).every(({ status }) => status === "pass"),
      true,
    );
  });

  await it("exposes driver-free codec and normalized performance helpers", () => {
    assertCodecConformance(
      defineCodecConformanceFixture({
        name: "bigint",
        decode: (value: string) => BigInt(value),
        cases: [
          { name: "zero", input: "0", expected: 0n },
          { name: "large", input: "9007199254740993", expected: 9007199254740993n },
        ],
      }),
    );
    const result = measureGrammarPerformance({
      dialect: postgresDialect,
      snapshot: postgresSnapshot,
      queries: ["SELECT value FROM widgets", "SELECT label FROM widgets"],
      warmups: 1,
      samples: 3,
    });
    strict.deepStrictEqual(
      { queryCount: result.queryCount, warmups: result.warmups, samples: result.samples },
      { queryCount: 2, warmups: 1, samples: 3 },
    );
    strict.ok(result.p95Milliseconds >= result.p50Milliseconds);
    strict.ok(result.minimumQueriesPerSecond > 0);
  });

  await it("verifies renderer and driver-free runtime adapter behavior", async () => {
    await assertRuntimeAdapterConformance({
      name: "postgres-runtime",
      renderer: postgresRenderer,
      query: postgresSql`SELECT ${42n} AS value`,
      expectedText: "SELECT $1 AS value",
      expectedValues: [42n],
      rows: [{ value: 42n }],
    });
    await assertRuntimeAdapterConformance({
      name: "mysql-runtime",
      renderer: mysqlRenderer,
      query: mysqlSql`SELECT ${42n} AS value`,
      expectedText: "SELECT ? AS value",
      expectedValues: [42n],
      rows: [{ value: 42n }],
    });
  });
});
