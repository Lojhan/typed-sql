import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const legacy = process.env.TYPED_SQL_DUCKDB_SDK === "15";
const sdk = await import(legacy ? "duckdb-node-15" : "@duckdb/node-api");
const version = legacy ? "1.5.6" : "2.0.0";
if (sdk.version() !== `v${version}`) throw new Error("Unexpected native qualification engine");
const names = [
  "DECIMAL(18,3)",
  "BOOLEAN",
  "TINYINT",
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "HUGEINT",
  "UTINYINT",
  "USMALLINT",
  "UINTEGER",
  "UBIGINT",
  "UHUGEINT",
  "BIGNUM",
  "FLOAT",
  "DOUBLE",
  "VARCHAR",
  "JSON",
  "BLOB",
  "BIT",
  "UUID",
  "DATE",
  "TIME",
  "TIMETZ",
  "TIMESTAMP",
  "TIMESTAMP_S",
  "TIMESTAMP_MS",
  "TIMESTAMP_NS",
  "TIMESTAMPTZ",
  "INTERVAL",
  ...(legacy ? [] : ["TIME_NS", "TIMESTAMPTZ_NS"]),
].sort();
const instance = await sdk.DuckDBInstance.create(),
  connection = await instance.connect();
const types = {},
  expressionTypes = {};
const nativeType = (type) => (type.alias?.toUpperCase() === "JSON" ? "JSON" : type.toString());
try {
  const versionResult = await connection.run("SELECT version()");
  try {
    if ((await versionResult.getRows())[0]?.[0] !== `v${version}`) throw new Error("Native SQL version disagrees");
  } finally {
    versionResult.closeSync();
  }
  for (let a = 0; a < names.length; a++)
    for (let b = 0; b < names.length; b++) {
      if (a === b) continue;
      const left = names[a],
        right = names[b];
      let statement;
      try {
        statement = await connection.prepare(`SELECT NULL::${left} AS value UNION ALL SELECT NULL::${right}`);
        types[`${left.startsWith("DECIMAL") ? "DECIMAL" : left}|${right.startsWith("DECIMAL") ? "DECIMAL" : right}`] =
          nativeType(statement.columnType(0));
      } catch {
        types[`${left.startsWith("DECIMAL") ? "DECIMAL" : left}|${right.startsWith("DECIMAL") ? "DECIMAL" : right}`] =
          null;
      } finally {
        statement?.destroySync();
      }
      let expression;
      try {
        expression = await connection.prepare(`SELECT list_value(NULL::${left},NULL::${right})`);
        expressionTypes[
          `${left.startsWith("DECIMAL") ? "DECIMAL" : left}|${right.startsWith("DECIMAL") ? "DECIMAL" : right}`
        ] = nativeType(expression.columnType(0).valueType);
      } catch {
        expressionTypes[
          `${left.startsWith("DECIMAL") ? "DECIMAL" : left}|${right.startsWith("DECIMAL") ? "DECIMAL" : right}`
        ] = null;
      } finally {
        expression?.destroySync();
      }
    }
} finally {
  connection.closeSync();
  instance.closeSync();
}
const output = `// Generated from genuine DuckDB ${version} native set-operation combination types.\nexport const commonTypes: Readonly<Record<string, string | null>> = ${JSON.stringify(types, null, 2)};\nexport const expressionTypes: Readonly<Record<string, string | null>> = ${JSON.stringify(expressionTypes, null, 2)};\n`;
const destination = fileURLToPath(new URL(`../src/catalog/common-${version}.ts`, import.meta.url));
if (process.argv.includes("--check")) {
  // Formatting is part of the deterministic generated artifact.
  const formatted = spawnSync("pnpm", ["exec", "biome", "format", "--stdin-file-path", destination], {
    input: output,
    encoding: "utf8",
  });
  if (formatted.status !== 0) throw new Error(formatted.stderr);
  if ((await readFile(destination, "utf8")) !== formatted.stdout)
    throw new Error(`Stale DuckDB combination catalog ${version}`);
} else {
  await writeFile(destination, output);
  const formatted = spawnSync("pnpm", ["exec", "biome", "format", "--write", destination], { stdio: "inherit" });
  if (formatted.status !== 0) throw new Error("Cannot format combination catalog");
}
