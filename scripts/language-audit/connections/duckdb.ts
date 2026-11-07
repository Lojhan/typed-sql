import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DUCKDB_SUPPORT_POLICY, duckDBServerEvidence } from "../../../packages/duckdb/src/support.js";
import { duckDBNativeTypeText } from "../duckdb-description.mjs";

export const liveDuckDBTargets = DUCKDB_SUPPORT_POLICY.qualifiedEngines;

import type { AuditConnection, AuditConnectionOptions, AuditConnectionOwner } from "./contracts.js";

async function connect(options: AuditConnectionOptions): Promise<AuditConnection> {
  const selected = options.version;
  const version = selected ?? "2.0.0";
  if (!liveDuckDBTargets.includes(version as "1.5.6" | "2.0.0")) throw new Error(`Unknown DuckDB target ${version}`);
  const require = createRequire(fileURLToPath(new URL("../../../packages/duckdb/package.json", import.meta.url)));
  const sdkName = version === "1.5.6" ? "duckdb-node-15" : "@duckdb/node-api";
  const sdk = require(sdkName);
  const sdkVersion = require(`${sdkName}/package.json`).version;
  const instance = await sdk.DuckDBInstance.create();
  const db = await instance.connect();
  const query = async (sql: string): Promise<Record<string, unknown>[]> =>
    (await db.runAndReadAll(sql)).getRowObjectsJson();
  const [row] = await query("SELECT version() AS version");
  const actual = String(row!.version).replace(/^v/u, "");
  if (actual !== version) throw new Error(`Expected DuckDB ${version}, got ${actual}`);
  const settings = Object.fromEntries(
    (
      await query(
        "SELECT name,value FROM duckdb_settings() WHERE name IN ('Calendar','integer_division','preserve_identifier_case','old_implicit_casting')",
      )
    ).map((item) => [String(item.name), String(item.value)]),
  );
  return {
    target: {
      version: actual,
      sdk: sdkVersion,
      platform: process.platform,
      arch: process.arch,
      runtime: process.version,
    },
    query,
    server: duckDBServerEvidence(actual, [], settings),
    prepare: async (sql: string) => {
      try {
        const statement = await db.prepare(sql);
        try {
          const columns = Array.from({ length: statement.columnCount }, (_, index) => {
            let nativeType: string | null = null;
            let nativeTypeStructure: unknown = null;
            let typeKnowledge = "native preparation";
            try {
              const descriptor = statement.columnType(index);
              nativeType = duckDBNativeTypeText(descriptor, sdk.DuckDBTypeId);
              nativeTypeStructure = descriptor.toJson();
            } catch (error) {
              if (!/^Unexpected type id: \d+$/u.test(String((error as Error).message))) throw error;
              typeKnowledge = `driver descriptor unavailable: ${String((error as Error).message)}`;
            }
            return {
              name: statement.columnName(index),
              engineType: statement.columnTypeId(index),
              nativeType,
              nativeTypeStructure,
              typeKnowledge,
              nullable: null,
            };
          });
          return {
            accepted: true,
            metadata: {
              status: "native preparation metadata for this invocation",
              columns,
              parameterCount: statement.parameterCount,
            },
          };
        } finally {
          statement.destroySync();
        }
      } catch (error) {
        const message = String((error as Error).message);
        if (
          !message.startsWith("Invalid Error: Unnamed parameters cannot come after named parameters") &&
          !/(?:Parser|Binder|Catalog|Invalid Input|Not implemented|Conversion|IO|Invalid Type|Out of Range|Type Mismatch|Invalid Configuration|Parameter Not Allowed|Parameter Not Resolved) Error/iu.test(
            message,
          )
        )
          throw error;
        return { accepted: false, reason: message.split("\n")[0] ?? "native preparation rejected" };
      }
    },
    close: () => {
      db.closeSync();
      instance.closeSync();
    },
  };
}

export const duckdbConnection: AuditConnectionOwner = { id: "duckdb", connect, captureTargets: liveDuckDBTargets };
