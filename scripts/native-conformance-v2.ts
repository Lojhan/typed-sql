/** Static maintainer corpora through published grammar/conformance entrypoints.
 * Native execution remains an explicit, separately configured qualification shard.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ConformanceProbe, ConformanceTarget, ExpectedColumn } from "../packages/conformance/src/v2/index.js";
import type { DialectPlugin, SchemaSnapshot, SourceRange, SqlRenderer } from "../packages/core/src/index.js";
import { MATURITY_CASES, maturitySnapshot } from "../packages/sqlserver/test/helpers/maturity-corpus.js";

const root = fileURLToPath(new URL("../", import.meta.url));
async function published<Module>(name: string, subpath = ""): Promise<Module> {
  const application = createRequire(resolve(root, "packages", name, "package.json"));
  return (await import(pathToFileURL(application.resolve(`@typed-sql/${name}${subpath}`)).href)) as Module;
}
const api = await published<typeof import("../packages/conformance/src/v2/index.js")>("conformance", "/v2");
const argument = process.argv[2];
if (argument !== "sqlserver" && argument !== "duckdb") throw new TypeError("Select sqlserver or duckdb");
const grammar: "sqlserver" | "duckdb" = argument;
const plugins = {
  sqlserver: await published<typeof import("../packages/sqlserver/src/analysis.js")>("sqlserver", "/analysis"),
  duckdb: await published<typeof import("../packages/duckdb/src/analysis.js")>("duckdb", "/analysis"),
};
const query = await published<{ renderer: SqlRenderer }>(grammar, "/query");
const dialect: DialectPlugin = grammar === "sqlserver" ? plugins.sqlserver.sqlserver() : plugins.duckdb.duckdb();
const renderer = query.renderer;
const target: ConformanceTarget = {
  grammar,
  grammarVersion: dialect.grammarVersion,
  databaseVersion: grammar === "sqlserver" ? "17.0.5035.5" : "2.0.0",
};
const snapshot: SchemaSnapshot =
  grammar === "sqlserver"
    ? maturitySnapshot()
    : {
        formatVersion: 1,
        dialect: "duckdb",
        server: plugins.duckdb.duckDBServerEvidence("2.0.0", [], {
          Calendar: "gregorian",
          integer_division: "false",
          preserve_identifier_case: "preserve_case",
          currentCatalog: "memory",
          currentSchema: "main",
        }),
        tables: {
          users: {
            name: "users",
            schema: "main",
            columns: {
              id: { name: "id", databaseType: "BIGINT", tsType: "bigint", nullable: false },
              email: { name: "email", databaseType: "VARCHAR", tsType: "string", nullable: false },
              team_id: { name: "team_id", databaseType: "INTEGER", tsType: "number", nullable: true },
            },
          },
        },
      };
function range(source: string, text: string, last = false): SourceRange {
  const start = last ? source.lastIndexOf(text) : source.indexOf(text);
  if (start < 0) throw new Error("Invalid maintainer projection fixture");
  const before = source.slice(0, start);
  return { start, end: start + text.length, line: before.split("\n").length, column: start - before.lastIndexOf("\n") };
}
const projections: Readonly<Record<string, readonly string[]>> = {
  "left-join": ["w.id", "c.amount"],
  "full-join": ["w.id AS widget_id", "c.id AS child_id"],
  "cross-apply-correlated": ["w.id", "a.amount"],
  "outer-apply-correlated": ["w.id", "a.amount"],
  "window-rank": ["id", "ROW_NUMBER() OVER (PARTITION BY active ORDER BY quantity DESC) AS rank"],
  "insert-output": ["inserted.id"],
  "delete-output": ["deleted.id"],
  "update-output-old-new": ["deleted.quantity AS old_quantity", "inserted.quantity AS new_quantity"],
  "known-scalar-functions": ["LEN(code) AS length", "DATALENGTH(code) AS bytes", "ABS(quantity) AS magnitude"],
};
function probe(
  id: string,
  featureId: string,
  source: string,
  columns: readonly ExpectedColumn[],
  schemaFixture: string,
): ConformanceProbe {
  const rowType = `{ ${columns.map((c) => `${JSON.stringify(c.name)}: ${c.tsType}${c.nullable ? " | null" : ""};`).join(" ")} }`;
  return api.defineConformanceProbe({
    version: 2,
    id,
    featureId,
    grammar,
    targets: [target],
    source,
    schemaFixture,
    compilerSource: `import { sql } from "@typed-sql/${grammar}";\nexport const query = sql\`${source.replaceAll("`", "\\`")}\`;`,
    expected: [
      {
        target: { databaseVersion: target.databaseVersion! },
        support: "exact",
        rows: columns,
        parameters: [],
        diagnostics: [],
        resultKind: "rows",
        compiled: { rowType, parameterType: "readonly []" },
      },
    ],
  });
}
const probes: ConformanceProbe[] = [];
const sqlFeatures: Readonly<Record<string, string>> = {
  aggregates: "expression.function.call",
  apply: "query.sqlserver.apply",
  builtins: "expression.function.call",
  casts: "expression.cast",
  coercions: "resolver.catalog",
  conditionals: "expression.structured",
  ctes: "query.cte",
  derived: "query.relation",
  joins: "query.join",
  json: "expression.sqlserver.json",
  nullability: "resolver.catalog",
  output: "statement.sqlserver.output",
  pagination: "query.ordering-pagination",
  predicates: "expression.structured",
  "set-operations": "query.set-operation",
  subqueries: "expression.structured",
  top: "query.sqlserver.top",
  windows: "query.window",
  xml: "expression.function.call",
};
if (grammar === "sqlserver") {
  for (const test of MATURITY_CASES) {
    const texts =
      test.projectionTexts ??
      projections[test.id] ??
      (test.rows[0]?.name === "value"
        ? [test.sql.slice("SELECT ".length, test.sql.lastIndexOf(" AS value") + " AS value".length)]
        : test.rows.map((column) => column.name));
    probes.push(
      probe(
        `sqlserver.maturity.${test.id}`,
        sqlFeatures[test.feature]!,
        test.sql,
        test.rows.map((column, index) => ({
          ...column,
          range: range(test.sql, texts[index]!, test.id === "cte-column-list"),
        })),
        "packages/sqlserver/test/helpers/maturity-corpus.ts",
      ),
    );
  }
} else {
  // Native physical expectations and documented logical policy come from the
  // analytical, DML and nested-type corpora, rather than resolver output.
  const cases: readonly [string, string, string, string, string, boolean][] = [
    ["integer", "SELECT 1 AS value", "1", "value", "number", false],
    ["bigint", "SELECT id FROM users", "id", "id", "bigint", false],
    ["decimal", "SELECT 1.20 AS value", "1.20", "value", "string", false],
    ["list", "SELECT [1,2] AS value", "[1,2]", "value", "readonly (number | null)[]", false],
    [
      "array",
      "SELECT array_value(1,2) AS value",
      "array_value(1,2)",
      "value",
      "readonly [number | null, number | null]",
      false,
    ],
    [
      "struct",
      "SELECT {'id':id} AS value FROM users",
      "{'id':id}",
      "value",
      '{ readonly "id": bigint | null; }',
      false,
    ],
    [
      "map",
      "SELECT MAP {'a':1} AS value",
      "MAP {'a':1}",
      "value",
      "readonly (readonly [string, number | null])[]",
      false,
    ],
    [
      "union",
      "SELECT union_value(n:=1) AS value",
      "union_value(n:=1)",
      "value",
      '{ readonly tag: "n"; readonly value: number | null; }',
      false,
    ],
    ["tuple", "SELECT row(1,'x') AS value", "row(1,'x')", "value", "readonly [number | null, string | null]", false],
    [
      "interval",
      "SELECT INTERVAL '1 day' AS value",
      "INTERVAL '1 day'",
      "value",
      "{ readonly months: number; readonly days: number; readonly micros: bigint; }",
      false,
    ],
    [
      "lambda",
      "SELECT list_transform([1,2],lambda x:x+1) AS value",
      "list_transform([1,2],lambda x:x+1)",
      "value",
      "readonly (number | null)[]",
      false,
    ],
    ["aggregate", "SELECT count(*) AS value FROM users", "count(*)", "value", "bigint", false],
    [
      "window",
      "SELECT row_number() OVER(ORDER BY id) AS value FROM users QUALIFY value=1",
      "row_number() OVER(ORDER BY id)",
      "value",
      "bigint",
      false,
    ],
    ["returning", "INSERT INTO users(id,email) VALUES(1,'x') RETURNING id", "id", "id", "bigint", false],
  ];
  const physical: Readonly<Record<string, string>> = {
    integer: "INTEGER",
    bigint: "BIGINT",
    decimal: "DECIMAL(3,2)",
    list: "INTEGER[]",
    array: "INTEGER[2]",
    struct: 'STRUCT("id" BIGINT)',
    map: "MAP(VARCHAR, INTEGER)",
    union: 'UNION("n" INTEGER)',
    tuple: "TUPLE(INTEGER, VARCHAR)",
    interval: "INTERVAL",
    lambda: "INTEGER[]",
    aggregate: "BIGINT",
    window: "BIGINT",
    returning: "BIGINT",
  };
  for (const [id, source, expression, name, tsType, nullable] of cases)
    probes.push(
      probe(
        `duckdb.native.${id}`,
        (
          {
            integer: "expression.scalar",
            bigint: "expression.scalar",
            decimal: "expression.scalar",
            list: "expression.array.constructor",
            array: "expression.array.constructor",
            struct: "type.duckdb.struct",
            map: "type.duckdb.map",
            union: "type.duckdb.union",
            tuple: "type.duckdb.struct",
            interval: "expression.interval-literal",
            lambda: "expression.duckdb.lambda",
            aggregate: "expression.function.call",
            window: "query.duckdb.qualify",
            returning: "statement.dml.returning",
          } as Readonly<Record<string, string>>
        )[id]!,
        source,
        [{ name, tsType, nullable, databaseType: physical[id]!, range: range(source, expression, id === "returning") }],
        "packages/duckdb/test/analytical.test.ts",
      ),
    );
}
const table = grammar === "sqlserver" ? "dbo.widgets" : "users";
const before = `SELECT id FROM ${table} WHERE id=`,
  between = " OR id=";
const parameterSource = `${before}${dialect.placeholder(1)}${between}${dialect.placeholder(2)}`;
const idType = grammar === "sqlserver" ? "bigint" : "BIGINT";
probes.push(
  api.defineConformanceProbe({
    version: 2,
    id: `${grammar}.parameters.ordered`,
    featureId: "lexical.structure",
    grammar,
    targets: [target],
    source: parameterSource,
    schemaFixture:
      grammar === "sqlserver"
        ? "packages/sqlserver/test/helpers/maturity-corpus.ts"
        : "packages/duckdb/test/grammar.test.ts",
    query: {
      segments: [
        { kind: "text", text: before },
        { kind: "value", value: 1n },
        { kind: "text", text: between },
        { kind: "value", value: 2n },
      ],
    },
    compilerSource: [
      `import { sql } from "@typed-sql/${grammar}"; declare const left: bigint; declare const right: bigint; `,
      "export const query=sql`",
      before,
      `\${left}`,
      between,
      `\${right}`,
      "`;",
    ].join(""),
    expected: [
      {
        target: { databaseVersion: target.databaseVersion! },
        support: "exact",
        rows: [
          { name: "id", tsType: "bigint", nullable: false, databaseType: idType, range: range(parameterSource, "id") },
        ],
        parameters: [1, 2].map((index) => ({ index, tsType: "bigint", nullable: false, databaseType: idType })),
        diagnostics: [],
        compiled: { rowType: '{ "id": bigint; }', parameterType: "readonly [bigint, bigint]" },
        rendered: { text: parameterSource, values: [1n, 2n] },
      },
    ],
  }),
);
const invalidSource = "-- 😀\nSELECT (";
probes.push(
  api.defineConformanceProbe({
    version: 2,
    id: `${grammar}.diagnostics.utf16`,
    featureId: "tooling.diagnostics",
    grammar,
    targets: [target],
    source: invalidSource,
    schemaFixture: "packages/conformance/test/native-feature-ledger.test.ts",
    expected: [
      {
        target: { databaseVersion: target.databaseVersion! },
        support: "unsupported",
        rows: [],
        parameters: [],
        diagnostics: [
          {
            code: "TSQ001",
            severity: "error",
            range: { start: invalidSource.length, end: invalidSource.length, line: 2, column: 9 },
          },
        ],
      },
    ],
  }),
);
const ledgerApi = await published<typeof import("../packages/conformance/src/index.js")>("conformance");
api.defineConformanceSuite(
  { version: 2, name: `${grammar}-maintainer`, probes },
  ledgerApi.parseGrammarFeatureLedger(
    JSON.parse(await readFile(resolve(root, "grammar/features/ledger.json"), "utf8")) as unknown,
  ),
);
const selected = probes.filter(
  (entry) =>
    (!process.env.TYPED_SQL_CONFORMANCE_PROBE || process.env.TYPED_SQL_CONFORMANCE_PROBE === entry.id) &&
    (!process.env.TYPED_SQL_CONFORMANCE_FIXTURE_GROUP ||
      process.env.TYPED_SQL_CONFORMANCE_FIXTURE_GROUP === "native" ||
      (process.env.TYPED_SQL_CONFORMANCE_FIXTURE_GROUP === "statement.select" &&
        /^(?:SELECT|WITH)\b/u.test(entry.source))),
);
if (!selected.length) throw new TypeError("No native maintainer probes match the selected filters");
const results = selected.map((entry) => api.runStaticConformanceProbe(entry, target, { dialect, snapshot, renderer }));
const environment = {
  grammar,
  grammarVersion: dialect.grammarVersion,
  databaseVersion: target.databaseVersion!,
  runtime: "node",
  runtimeVersion: process.version,
  schemaFingerprint: `sha256:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`,
  capabilities: { staticMaintainerCorpus: true, publishedEntrypoints: true },
};
const report = api.createConformanceReport(`${grammar} static maintainer corpus`, environment, results);
const artifacts = resolve(root, "artifacts/conformance");
await mkdir(artifacts, { recursive: true });
await writeFile(resolve(artifacts, `${grammar}-static.json`), api.serializeConformanceReport(report));
const failed = results.find((result) => result.status === "fail");
if (failed) {
  const entry = selected.find((candidate) => candidate.id === failed.probeId)!;
  const reproduction = api.createConformanceReproductionBundle(entry, target, environment, entry.expected[0]!, failed);
  await writeFile(
    resolve(artifacts, `${grammar}-reproduction.json`),
    api.serializeConformanceReproductionBundle({
      ...reproduction,
      command: `pnpm conformance:v2 -- --grammar ${grammar} --probe ${entry.id}`,
    }),
  );
} else await rm(resolve(artifacts, `${grammar}-reproduction.json`), { force: true });
process.stdout.write(api.formatConformanceReport(report));
if (report.summary.fail) process.exitCode = 1;
