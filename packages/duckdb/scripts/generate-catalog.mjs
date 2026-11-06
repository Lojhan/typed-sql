import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const version = process.env.TYPED_SQL_DUCKDB_SDK === "15" ? "1.5.6" : "2.0.0";
const sdk = await import(version === "1.5.6" ? "duckdb-node-15" : "@duckdb/node-api");
if (sdk.version() !== `v${version}`) throw new Error("Catalog generation loaded the wrong native engine");
const instance = await sdk.DuckDBInstance.create(),
  connection = await instance.connect();
const scalarTypes = [
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
  "DECIMAL",
  "VARCHAR",
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
  "JSON",
  ...(version === "2.0.0" ? ["TIME_NS", "TIMESTAMPTZ_NS"] : []),
];
const sqlType = (type) => (type === "DECIMAL" ? "DECIMAL(18,3)" : type);
try {
  const result = await connection.run(
    "SELECT function_name,function_type,parameter_types,return_type,varargs,stability,has_side_effects FROM duckdb_functions() WHERE internal AND function_type IN ('scalar','aggregate','window') AND database_name='system' ORDER BY function_name,function_type,parameter_types,return_type,varargs",
  );
  const rows = await result.getRows();
  result.closeSync();
  const signatures = rows.map(([name, kind, parameters, returns, varargs, stability, sideEffects]) => [
    name,
    kind,
    parameters.items,
    returns,
    varargs,
    stability,
    sideEffects,
  ]);
  const unique = [...new Map(signatures.map((row) => [JSON.stringify(row), row])).values()];
  const casts = [];
  for (const source of scalarTypes) {
    const query = scalarTypes
      .map(
        (target) =>
          `SELECT '${source}', '${target}', can_cast_implicitly(NULL::${sqlType(source)},NULL::${sqlType(target)})`,
      )
      .join(" UNION ALL ");
    const result = await connection.run(query);
    try {
      for (const [source, target, allowed] of await result.getRows()) if (allowed) casts.push([source, target]);
    } finally {
      result.closeSync();
    }
  }
  const checksum = createHash("sha256")
    .update(JSON.stringify({ signatures: unique, casts }))
    .digest("hex");
  const source = `// Generated from DuckDB ${version} duckdb_functions() and can_cast_implicitly(); do not edit by hand.\n// Source snapshot sha256:${checksum}\nimport type { DuckDBBuiltinSignature } from "./types.js";\nexport const signatures: readonly DuckDBBuiltinSignature[] = ${JSON.stringify(unique)};\nexport const implicitCasts: readonly (readonly [string,string])[] = ${JSON.stringify(casts)};\n`;
  const file = new URL(`../src/catalog/${version}.ts`, import.meta.url);
  const formatted = spawnSync("pnpm", ["exec", "biome", "format", "--stdin-file-path", fileURLToPath(file)], {
    input: source,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (formatted.status !== 0) throw new Error(formatted.stderr);
  if (process.argv.includes("--check")) {
    if ((await readFile(file, "utf8")) !== formatted.stdout)
      throw new Error(`DuckDB${version} builtin catalog is stale`);
  } else await writeFile(file, formatted.stdout);
  console.log(
    `DuckDB${version}: ${unique.length} exact native overloads, ${casts.length} implicit casts; sha256:${checksum}`,
  );
} finally {
  connection.closeSync();
  instance.closeSync();
}
