import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const options = Object.create(null);
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith("--") || value === undefined) throw new TypeError(`Invalid argument ${name ?? "<missing>"}`);
  options[name.slice(2)] = value;
}
if (!new Set(["cli", "node"]).has(options.adapter)) throw new TypeError("--adapter must be cli or node");
if (typeof options.output !== "string" || options.output.length === 0) throw new TypeError("--output is required");
if (typeof options.label !== "string" || options.label.length === 0) throw new TypeError("--label is required");
if (options.adapter === "cli" && (typeof options.executable !== "string" || options.executable.length === 0)) {
  throw new TypeError("--executable is required for the cli adapter");
}

const parseVersion = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
  if (match === null) throw new TypeError(`Cannot normalize SQLite version ${JSON.stringify(value)}`);
  return match.slice(1).map(Number);
};
const compareVersion = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
};
const atLeast = (actual, minimum) => compareVersion(actual, parseVersion(minimum)) >= 0;

function cli(sql) {
  const result = spawnSync(options.executable, ["-batch", "-json", "-cmd", ".explain off", ":memory:", sql], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error("sqlite3 CLI rejected the probe");
  const output = result.stdout.trim();
  return output.length === 0 ? [] : JSON.parse(output);
}

let nodeDatabase;
if (options.adapter === "node") {
  const { DatabaseSync } = await import("node:sqlite");
  nodeDatabase = new DatabaseSync(":memory:");
}
function node(sql, setup = "") {
  if (setup.length > 0) nodeDatabase.exec(setup);
  const statement = nodeDatabase.prepare(sql);
  statement.setReadBigInts(true);
  return statement.all();
}
function execute(sql, setup = "") {
  return options.adapter === "node" ? node(sql, setup) : cli(`${setup}\n${sql}`);
}

const versionRows = execute("SELECT sqlite_version() AS version");
const libraryVersion = String(versionRows[0]?.version ?? "");
const parsedVersion = parseVersion(libraryVersion);
const compileOptions = execute("PRAGMA compile_options")
  .map((row) => String(row.compile_options))
  .sort();
const compileOptionSet = new Set(compileOptions);
if (options.adapter === "node" && process.versions.sqlite !== undefined && process.versions.sqlite !== libraryVersion) {
  throw new Error("node:sqlite version evidence disagrees with process.versions.sqlite");
}

const jsonAvailable = atLeast(parsedVersion, "3.38.0") && !compileOptionSet.has("OMIT_JSON");
const probes = [
  {
    id: "statement.select",
    featureIds: ["statement.select", "query.projection", "query.relation", "runtime.execution"],
    expected: true,
    sql: "SELECT 1 AS value",
  },
  {
    id: "expression.cast",
    featureIds: ["expression.cast"],
    expected: true,
    sql: "SELECT CAST(1 AS TEXT) AS value",
  },
  {
    id: "expression.scalar-structured",
    featureIds: ["expression.scalar", "expression.structured"],
    expected: true,
    sql: "SELECT CASE WHEN (1, 2) = (1, 2) THEN 1 + 2 ELSE 0 END AS value",
  },
  {
    id: "query-structure",
    featureIds: ["query.cte", "query.distinct", "query.grouping", "query.ordering-pagination", "query.set-operation"],
    expected: true,
    sql: "WITH input(value) AS (SELECT 1 UNION ALL SELECT 2) SELECT DISTINCT max(value) AS value FROM input GROUP BY value ORDER BY value LIMIT 1",
  },
  {
    id: "query.recursive-cte",
    featureIds: ["query.with.recursive"],
    expected: true,
    sql: "WITH RECURSIVE counter(value) AS (VALUES (1) UNION ALL SELECT value + 1 FROM counter WHERE value < 3) SELECT max(value) AS value FROM counter",
  },
  {
    id: "query.full-outer-join",
    featureIds: ["query.join", "query.join.full"],
    expected: atLeast(parsedVersion, "3.39.0"),
    setup: "CREATE TABLE left_value(id INTEGER); CREATE TABLE right_value(id INTEGER);",
    sql: "SELECT count(*) AS value FROM left_value FULL OUTER JOIN right_value USING (id)",
  },
  {
    id: "schema.strict-table",
    featureIds: ["schema.table.strict"],
    expected: atLeast(parsedVersion, "3.37.0"),
    setup: "CREATE TABLE strict_value(id INTEGER) STRICT;",
    sql: "SELECT count(*) AS value FROM strict_value",
  },
  {
    id: "write.returning",
    featureIds: ["statement.insert", "statement.dml.returning"],
    expected: atLeast(parsedVersion, "3.35.0"),
    setup: "CREATE TABLE returning_value(id INTEGER);",
    sql: "INSERT INTO returning_value VALUES (1) RETURNING id",
  },
  {
    id: "write.update-from",
    featureIds: ["statement.update", "statement.dml.update-from"],
    expected: atLeast(parsedVersion, "3.33.0"),
    setup:
      "CREATE TABLE update_target(id INTEGER, value TEXT); CREATE TABLE update_source(id INTEGER, value TEXT); INSERT INTO update_target VALUES (1, 'old'); INSERT INTO update_source VALUES (1, 'new');",
    sql: "UPDATE update_target SET value = update_source.value FROM update_source WHERE update_target.id = update_source.id RETURNING value",
  },
  {
    id: "expression.window-filter",
    featureIds: ["expression.aggregate.filter", "query.window"],
    expected: atLeast(parsedVersion, "3.30.0") && !compileOptionSet.has("OMIT_WINDOWFUNC"),
    sql: "SELECT count(*) FILTER (WHERE value > 0) OVER () AS value FROM (SELECT 1 AS value UNION ALL SELECT 2)",
  },
  {
    id: "expression.function.json",
    featureIds: ["expression.function.json"],
    expected: jsonAvailable,
    sql: "SELECT json_extract('{\"value\":1}', '$.value') AS value",
  },
  {
    id: "expression.function.jsonb",
    featureIds: ["expression.function.json"],
    expected: jsonAvailable && atLeast(parsedVersion, "3.45.0"),
    sql: "SELECT typeof(jsonb('{}')) AS value",
  },
  {
    id: "expression.function.date-time",
    featureIds: ["expression.function.date-time"],
    expected: true,
    sql: "SELECT date('2024-01-01', '+1 day') AS value",
  },
  {
    id: "expression.function.timediff",
    featureIds: ["expression.function.date-time"],
    expected: atLeast(parsedVersion, "3.43.0"),
    sql: "SELECT timediff('2024-01-02', '2024-01-01') AS value",
  },
  {
    id: "expression.function.math",
    featureIds: ["expression.function.math-extensions"],
    expected: compileOptionSet.has("ENABLE_MATH_FUNCTIONS"),
    sql: "SELECT floor(1.5) AS value",
  },
  {
    id: "expression.function.percentile",
    featureIds: ["expression.function.math-extensions"],
    expected: atLeast(parsedVersion, "3.51.0") && compileOptionSet.has("ENABLE_PERCENTILE"),
    sql: "SELECT percentile_cont(value, 0.5) AS value FROM (SELECT 1 AS value UNION ALL SELECT 2)",
  },
  {
    id: "expression.function.json-array-insert",
    featureIds: ["expression.function.json"],
    expected: jsonAvailable && atLeast(parsedVersion, "3.53.0"),
    sql: "SELECT json_array_insert('[1]', '$[1]', 2) AS value",
  },
  {
    id: "schema.generated-column",
    featureIds: ["schema.column.generated-assignment"],
    expected: atLeast(parsedVersion, "3.31.0"),
    setup:
      "CREATE TABLE generated_value(input INTEGER, output INTEGER GENERATED ALWAYS AS (input + 1) STORED); INSERT INTO generated_value(input) VALUES (1);",
    sql: "SELECT output AS value FROM generated_value",
  },
  {
    id: "write.conflict",
    featureIds: ["statement.insert.conflict"],
    expected: atLeast(parsedVersion, "3.24.0"),
    setup:
      "CREATE TABLE conflict_value(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO conflict_value VALUES (1, 'old');",
    sql: "INSERT INTO conflict_value VALUES (1, 'new') ON CONFLICT(id) DO UPDATE SET value = excluded.value RETURNING value",
  },
  {
    id: "write.default-values",
    featureIds: ["statement.insert.default-values"],
    expected: true,
    setup: "CREATE TABLE default_value(id INTEGER PRIMARY KEY, value TEXT DEFAULT 'default');",
    sql: "INSERT INTO default_value DEFAULT VALUES RETURNING value",
  },
  {
    id: "write.delete",
    featureIds: ["statement.delete"],
    expected: true,
    setup: "CREATE TABLE delete_value(id INTEGER); INSERT INTO delete_value VALUES (1);",
    sql: "DELETE FROM delete_value WHERE id = 1 RETURNING id",
  },
];

const results = [];
for (const probe of probes) {
  let accepted = false;
  try {
    execute(probe.sql, probe.setup);
    accepted = true;
  } catch {
    accepted = false;
  }
  results.push({
    id: probe.id,
    featureIds: probe.featureIds,
    expected: probe.expected ? "available" : "not-required",
    actual: accepted ? "available" : "unavailable",
    status: probe.expected && !accepted ? "fail" : "pass",
  });
}

let prepareMetadata = { columns: "unavailable", parameters: "unavailable", nullability: "unavailable" };
if (options.adapter === "node") {
  const statement = nodeDatabase.prepare("SELECT 1 AS value");
  prepareMetadata = {
    columns: typeof statement.columns === "function" ? "available" : "unavailable",
    parameters: "unavailable",
    nullability: "unavailable",
  };
}
const planRows = execute("EXPLAIN QUERY PLAN SELECT value FROM (SELECT 1 AS value) WHERE value = 1");
const ledgerSource = await readFile(resolve("grammar/features/ledger.json"));
const ledger = JSON.parse(ledgerSource.toString("utf8"));
const liveFeatures = new Set(probes.flatMap(({ featureIds }) => featureIds));
liveFeatures.add("runtime.introspection");
const delegatedCoverage = {
  "expression.function.registry": "application-routine registry requires a host adapter",
  "runtime.codec-policy": "the official Node adapter codec suite runs in every Node matrix job",
  "runtime.streaming": "the official Node adapter stream suite runs in every Node matrix job",
  "schema.sqlite.structural-evidence": "snapshot provider contracts own structural introspection evidence",
  "tooling.compiler.artifacts": "compiler contracts are independent of the linked SQLite library",
  "tooling.diagnostics": "diagnostic contracts are static and fail before driver execution",
  "tooling.parser.resource-limits": "parser resource limits are independent of the linked SQLite library",
  "tooling.structural-sql": "structural interpolation contracts are enforced before driver execution",
};
const exactFeatureCoverage = ledger.entries
  .filter((entry) => entry.dialects.sqlite.level === "exact")
  .map(({ id }) => {
    if (liveFeatures.has(id)) return { featureId: id, kind: "live" };
    const reason = delegatedCoverage[id];
    if (reason === undefined) throw new Error(`SQLite exact feature ${id} has no matrix coverage classification`);
    return { featureId: id, kind: "delegated", reason };
  });
const maximum = parseVersion(ledger.dialects.sqlite.stable.at(-1).maximum);
const minimum = parseVersion(ledger.dialects.sqlite.stable[0].minimum);
const support =
  compareVersion(parsedVersion, minimum) < 0
    ? "below-supported"
    : compareVersion(parsedVersion, maximum) > 0
      ? "newer-than-tested"
      : "supported";
const artifact = {
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  target: {
    label: options.label,
    adapter: options.adapter === "node" ? "node:sqlite" : "sqlite3-cli",
    adapterVersion: options.adapter === "node" ? process.version : libraryVersion,
    runtime: "node",
    runtimeVersion: process.version,
    libraryVersion,
    support,
  },
  evidence: {
    compileOptions,
    featureLedger: {
      formatVersion: ledger.formatVersion,
      revision: `sha256:${createHash("sha256").update(ledgerSource).digest("hex")}`,
      exactFeatureCoverage,
    },
    prepareMetadata,
    plan: {
      advisory: true,
      nodeCount: planRows.length,
      unsupportedFacts: ["cost", "estimatedRows", "stableNodeShape"],
    },
  },
  results,
  summary: {
    pass: results.filter(({ status }) => status === "pass").length,
    fail: results.filter(({ status }) => status === "fail").length,
  },
};
nodeDatabase?.close();
const output = resolve(options.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
if (artifact.summary.fail > 0)
  throw new Error(`SQLite matrix target ${options.label} has ${artifact.summary.fail} differential failure(s)`);
process.stdout.write(`${libraryVersion} ${support} ${artifact.summary.pass} probes\n`);
