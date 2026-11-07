import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { duckDBNativeTypeText } from "../language-audit/duckdb-description.mjs";
import { hash } from "../language-audit/hash.mjs";
import { QUERIES, serialize } from "../language-audit/inventory.mjs";

// These probes only bind SQL. They never execute expressions or discovered functions.
export const combinationQueries = {
  set: (left, right) => `SELECT CAST($1 AS ${left}) UNION ALL SELECT CAST($2 AS ${right})`,
  expression: (left, right) => `SELECT COALESCE(CAST($1 AS ${left}), CAST($2 AS ${right}))`,
};
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const rejected = (error) =>
  /^(?:Binder|Catalog|Parser|Not implemented|Invalid Input|Invalid Type) Error:/u.test(error.message);

export async function captureCombinations(version) {
  const require = createRequire(new URL("../../packages/duckdb/package.json", import.meta.url));
  const sdkName = version.startsWith("1.") ? "duckdb-node-15" : "@duckdb/node-api";
  const sdk = require(sdkName);
  if (sdk.version() !== `v${version}`) throw new Error(`Unexpected DuckDB version: ${sdk.version()}`);
  const instance = await sdk.DuckDBInstance.create();
  const connection = await instance.connect();
  try {
    const rows = (await connection.runAndReadAll(QUERIES.duckdb.types)).getRowObjectsJson();
    const types = new Map();
    const unavailable = [];
    const aliases = {};
    for (const name of [...new Set(rows.map((row) => row.name))].sort()) {
      const logicalType = rows.find((row) => row.name === name)?.logical_type;
      if (["NULL", "ANY", "INVALID", "UNKNOWN"].includes(logicalType)) {
        unavailable.push({ name, reason: "Non-concrete catalog type; a prepared NULL may be represented as INTEGER" });
        continue;
      }
      let statement;
      try {
        statement = await connection.prepare(`SELECT CAST($1 AS ${quote(name)})`);
        const type = statement.columnType(0);
        const nativeType = duckDBNativeTypeText(type, sdk.DuckDBTypeId);
        aliases[name] = nativeType;
        if (
          ["LIST", "ARRAY", "STRUCT", "UNION", "MAP", "ENUM", "ANY", "SQLNULL"].some(
            (kind) => type.typeId === sdk.DuckDBTypeId[kind],
          )
        ) {
          unavailable.push({ name, reason: "Parametric or non-concrete type; requires structural semantic policy" });
        } else types.set(nativeType, nativeType);
      } catch (error) {
        if (!rejected(error) && !/^Unexpected type id: \d+$/u.test(error.message)) throw error;
        unavailable.push({ name, reason: error.message.split("\n")[0] });
      } finally {
        statement?.destroySync();
      }
    }
    const matrices = { set: [], expression: [] };
    for (const [mode, query] of Object.entries(combinationQueries)) {
      for (const left of [...types.keys()].sort()) {
        for (const right of [...types.keys()].sort()) {
          let statement;
          let result = null;
          try {
            statement = await connection.prepare(query(left, right));
            result = duckDBNativeTypeText(statement.columnType(0), sdk.DuckDBTypeId);
          } catch (error) {
            if (!rejected(error)) throw error;
          } finally {
            statement?.destroySync();
          }
          matrices[mode].push({ left, right, result });
        }
      }
    }
    return {
      formatVersion: 1,
      version,
      source: QUERIES.duckdb.types,
      inventoryFingerprint: hash(rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))),
      probes: {
        set: combinationQueries.set("<left>", "<right>"),
        expression: combinationQueries.expression("<left>", "<right>"),
      },
      aliases,
      unavailable,
      matrices,
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [mode, version, output] = process.argv.slice(2);
  if (!["capture", "check"].includes(mode) || !version || !output)
    throw new Error("Usage: duckdb-native.mjs capture|check VERSION PATH");
  const captured = await captureCombinations(version);
  if (mode === "check") {
    if (hash(captured) !== hash(JSON.parse(await readFile(output, "utf8"))))
      throw new Error(`Native DuckDB ${version} type derivations changed: ${output}`);
  } else {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${serialize(captured)}\n`);
  }
  console.log(`DuckDB ${version}: independently described ${captured.matrices.set.length} type pairs in each context`);
}
