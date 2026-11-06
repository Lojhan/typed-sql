import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { duckDBServerEvidence } from "../../packages/duckdb/src/support.js";
import { mySqlServerEvidence } from "../../packages/mysql/src/capabilities.js";
import { postgresServerEvidence } from "../../packages/postgres/src/capabilities.js";
import { auditInventory, checkReferences, writeAudit } from "./audit.js";
import { collectLive, diffInventory, inventory, serialize } from "./inventory.mjs";
import { acceptLiveBaseline, recordNativeFindings, reviewLiveBaseline } from "./live-baseline.mjs";
import { describeSqlServer, prepareMySql, preparePostgres, recognitionSummary } from "./native.mjs";
import { recognizeLive } from "./recognition.js";
import { directory, liveDuckDBTargets, refreshReferences } from "./references.js";
import { renderReport } from "./report.js";

const args = process.argv.slice(2);
const valuedOptions = new Set(["--dialect", "--version", "--output", "--baseline", "--before", "--after", "--input"]);
for (let index = 1; index < args.length; index++) {
  const flag = args[index]!;
  if (valuedOptions.has(flag)) {
    if (!args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error(`${flag} needs a value`);
    index++;
  } else if (!["--check", "--require-reviewed"].includes(flag)) throw new Error(`Unknown option ${flag}`);
}
const option = (name: string) => {
  const position = args.indexOf(name);
  if (position < 0) return undefined;
  const value = args[position + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
};
const mode = args[0];
if (mode === "refresh") {
  await refreshReferences();
} else if (mode === "check" || mode === "baseline") {
  await checkReferences(mode === "baseline");
  if (mode === "check") await renderReport(true);
} else if (mode === "report") {
  await renderReport(args.includes("--check"));
} else if (mode === "accept-live") {
  const input = option("--input")!;
  const body = JSON.parse(await readFile(input, "utf8"));
  const captured = body.evidence?.languageInventory ?? body.languageInventory ?? body;
  await acceptLiveBaseline(captured);
  let recognition = body.evidence?.languageRecognition ?? body.languageRecognition;
  if (!recognition) {
    try {
      recognition = JSON.parse(await readFile(`${input}.recognition.json`, "utf8"));
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  }
  await recordNativeFindings(captured, recognition);
  for (const profile of body.profiles ?? [])
    if (profile.languageInventory) {
      await acceptLiveBaseline(profile.languageInventory);
      await recordNativeFindings(profile.languageInventory, profile.languageRecognition);
    }
} else if (mode === "diff") {
  const before = JSON.parse(await readFile(option("--before")!, "utf8"));
  const after = JSON.parse(await readFile(option("--after")!, "utf8"));
  const changes = diffInventory(before, after);
  console.log(JSON.stringify(changes, null, 2));
  if (changes.length) process.exitCode = 1;
} else if (mode === "live") {
  const dialect = option("--dialect");
  const output = option("--output");
  if (!dialect || !output) throw new Error("live requires --dialect and --output");
  const live = await connect(dialect);
  try {
    const captured = await collectLive(dialect, live.query, live.target);
    if (dialect === "sqlite")
      captured.categories.extensions = inventory(
        await live.query("PRAGMA compile_options"),
        "PRAGMA compile_options",
        "compile-options",
      );
    await mkdir(dirname(resolve(output)), { recursive: true });
    await writeFile(output, `${serialize(captured)}\n`);
    await writeAudit([auditInventory(captured)], `${output}.audit.json`);
    const functions = captured.categories.functions;
    const referenceVersion =
      dialect === "mysql"
        ? String(live.target.version).split(".").slice(0, 2).join(".")
        : String(live.target.version).split(".")[0];
    const rows =
      functions?.rows ??
      JSON.parse(await readFile(resolve(directory, `${dialect}-${referenceVersion}.json`), "utf8")).categories.functions
        .rows;
    const recognition = await recognizeLive(dialect, String(live.target.version), rows, live.prepare, live.server);
    await writeFile(`${output}.recognition.json`, `${serialize(recognition)}\n`);
    const complete = { ...captured, recognition: recognitionSummary(recognition) };
    await writeFile(output, `${serialize(complete)}\n`);
    const reviewed = await reviewLiveBaseline(complete);
    await writeFile(`${output}.review.json`, `${JSON.stringify(reviewed, null, 2)}\n`);
    if (args.includes("--require-reviewed") && reviewed.status !== "match")
      throw new Error(`Live inventory requires review: ${output}.review.json`);
    const baseline = option("--baseline");
    if (baseline) {
      const changes = diffInventory(JSON.parse(await readFile(baseline, "utf8")), complete);
      await writeFile(`${output}.diff.json`, `${JSON.stringify(changes, null, 2)}\n`);
      if (changes.length)
        throw new Error(`${changes.length} upstream inventory changes require review: ${output}.diff.json`);
    }
    console.log(`${dialect} ${live.target.version}: live inventory and mapping observations written to ${output}`);
  } finally {
    await live.close();
  }
} else if (mode === "capture-embedded") {
  // Exact engine captures, independent of the grammar's committed builtin lists.
  for (const version of liveDuckDBTargets) {
    // Native DuckDB versions must run in separate processes; symbols can otherwise bind to
    // the first engine loaded into the process and falsely qualify a different SDK version.
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/language-audit/run.ts",
        "live",
        "--dialect",
        "duckdb",
        "--version",
        version,
        "--output",
        resolve("artifacts/language-audit", `duckdb-${version}.json`),
      ],
      { stdio: "inherit", env: { ...process.env, TSX_TSCONFIG_PATH: resolve("scripts/language-audit/tsconfig.json") } },
    );
    await writeFile(
      resolve(directory, `duckdb-${version}.json`),
      await readFile(resolve("artifacts/language-audit", `duckdb-${version}.json`), "utf8"),
    );
  }
} else throw new Error("Usage: audit:language refresh|check|baseline|live|diff|capture-embedded");

async function connect(dialect: string, selected = option("--version")) {
  if (dialect === "postgres") {
    const { Client } = await import("pg");
    if (!process.env.TYPED_SQL_AUDIT_URL) throw new Error("TYPED_SQL_AUDIT_URL is required");
    const client = new Client({ connectionString: process.env.TYPED_SQL_AUDIT_URL });
    await client.connect();
    const query = async (sql: string) => (await client.query(sql)).rows;
    const [row] = await query(
      "SELECT current_setting('server_version') AS version, current_setting('standard_conforming_strings') AS standard_conforming_strings, current_setting('search_path') AS search_path",
    );
    return {
      target: row,
      query,
      server: postgresServerEvidence(row.version, [], {
        standardConformingStrings: row.standard_conforming_strings,
        searchPath: row.search_path,
      }),
      prepare: (sql: string) => preparePostgres(client, sql),
      close: () => client.end(),
    };
  }
  if (dialect === "mysql") {
    const { createConnection } = await import("mysql2/promise");
    if (!process.env.TYPED_SQL_AUDIT_URL) throw new Error("TYPED_SQL_AUDIT_URL is required");
    const client = await createConnection(process.env.TYPED_SQL_AUDIT_URL);
    const query = async (sql: string) => (await client.query(sql))[0] as Record<string, unknown>[];
    const [row] = await query("SELECT VERSION() AS version, @@version_comment AS edition, @@sql_mode AS sql_mode");
    return {
      target: row,
      query,
      server: mySqlServerEvidence(String(row!.version), {
        versionComment: String(row!.edition),
        sqlMode: String(row!.sql_mode),
      }),
      prepare: (sql: string) => prepareMySql(client, sql),
      close: () => client.end(),
    };
  }
  if (dialect === "sqlite") {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    const query = async (sql: string): Promise<Record<string, unknown>[]> => {
      const rows = db.prepare(sql).all();
      return sql === "PRAGMA compile_options" ? rows.map((row) => ({ name: String(row.compile_options) })) : rows;
    };
    const [row] = await query("SELECT sqlite_version() AS version, sqlite_source_id() AS source_id");
    const prepare = async (sql: string) => {
      try {
        const statement = db.prepare(sql);
        return {
          accepted: true,
          metadata: {
            status: "native preparation metadata for this invocation; SQLite types may be dynamic",
            columns:
              typeof statement.columns === "function"
                ? statement.columns().map((column) => ({ name: column.name, nativeType: column.type, nullable: null }))
                : null,
            parameterCount: 0,
          },
        };
      } catch (error) {
        if ((error as { code?: string }).code !== "ERR_SQLITE_ERROR") throw error;
        return { accepted: false, reason: "ERR_SQLITE_ERROR" };
      }
    };
    const features = (await query("PRAGMA compile_options")).map((item) => String(item.name));
    return {
      target: { ...row, platform: process.platform, arch: process.arch, runtime: process.version },
      query,
      prepare,
      server: {
        product: "sqlite",
        version: String(row!.version),
        versionKey: String(row!.version),
        features,
        settings: {},
      },
      close: () => db.close(),
    };
  }
  if (dialect === "duckdb") {
    const version = selected ?? "2.0.0";
    if (!liveDuckDBTargets.includes(version as "1.5.6" | "2.0.0")) throw new Error(`Unknown DuckDB target ${version}`);
    const require = createRequire(resolve("packages/duckdb/package.json"));
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
              let typeKnowledge = "native preparation";
              try {
                nativeType = statement.columnType(index).toString();
              } catch (error) {
                if (!/^Unexpected type id: \d+$/u.test(String((error as Error).message))) throw error;
                typeKnowledge = `driver descriptor unavailable: ${String((error as Error).message)}`;
              }
              return { name: statement.columnName(index), nativeType, typeKnowledge, nullable: null };
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
  if (dialect === "sqlserver") {
    if (!process.env.TYPED_SQL_AUDIT_ODBC) throw new Error("TYPED_SQL_AUDIT_ODBC is required");
    const { createSqlServerOdbcDatabase } = await import("../../packages/sqlserver/src/odbc.js");
    const require = createRequire(resolve("e2e/sqlserver/package.json"));
    const db = await createSqlServerOdbcDatabase({
      connectionString: process.env.TYPED_SQL_AUDIT_ODBC,
      driverModulePath: require.resolve("koffi"),
    });
    return {
      target: { version: db.serverEvidence.version, settings: db.serverEvidence.settings },
      server: db.serverEvidence,
      query: (sql: string) => db.queryable.all(sql),
      prepare: (sql: string) => describeSqlServer(db.queryable, sql),
      close: () => db.close(),
    };
  }
  throw new Error(`Unknown dialect ${dialect}`);
}
