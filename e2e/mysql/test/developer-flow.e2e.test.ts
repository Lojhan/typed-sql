import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type MySqlSchemaSnapshot, mysql, sql, typePolicy } from "@typed-sql/mysql";
import { createMySql2Database } from "@typed-sql/mysql/mysql2";
import { analyzeSource } from "@typed-sql/ts-bridge";
import { NativePreviewTypeScriptBridge } from "@typed-sql/ts-bridge/native-preview";
import { createPool } from "mysql2/promise";
import { describe, it, log, strict, waitForExpectedResult, waitForPort } from "poku";
import { mysqlCodecFidelity } from "../src/codec-query.js";

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
interface GeneratedSnapshot {
  readonly dialect: string;
  readonly version?: string;
  readonly tables: Record<
    string,
    {
      readonly columns: Record<
        string,
        { readonly databaseType: string; readonly tsType: string; readonly nullable: boolean }
      >;
    }
  >;
  readonly functions?: Record<string, { readonly returnType: string }>;
  readonly metadata: { readonly schemaHash: string; readonly typePolicyHash: string };
}

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = resolve(packageDirectory, "../..");
const generatedDirectory = join(packageDirectory, "generated");
const generatedDatabaseDirectory = join(generatedDirectory, "db");
const generatedSnapshotPath = join(generatedDatabaseDirectory, "schema.json");
const cliFile = join(workspaceDirectory, "packages", "cli", "dist", "packages", "cli", "src", "cli.js");
const engine = process.env.TYPED_SQL_CONTAINER_ENGINE ?? "podman";
const port = Number(process.env.TYPED_SQL_MYSQL_E2E_PORT ?? "53306");
const containerName = `typed-sql-e2e-mysql-${process.pid}`;
const imageName = "localhost/typed-sql-e2e-mysql:8.4.11";
const connectionUri = `mysql://typed_sql:typed_sql_e2e@127.0.0.1:${port}/typed_sql_e2e`;
let containerStarted = false;

if (!Number.isInteger(port) || port < 1024 || port > 65_535)
  throw new TypeError("TYPED_SQL_MYSQL_E2E_PORT must be an unprivileged TCP port");

function run(command: string, args: readonly string[], cwd = packageDirectory): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
  });
}

async function mustRun(command: string, args: readonly string[], cwd = packageDirectory): Promise<CommandResult> {
  const result = await run(command, args, cwd);
  if (result.code !== 0)
    throw new Error(`${command} ${args.join(" ")} failed (${result.code})\n${result.stdout}${result.stderr}`);
  return result;
}

const cli = (...args: readonly string[]): Promise<CommandResult> => mustRun(process.execPath, [cliFile, ...args]);

await rm(generatedDirectory, { recursive: true, force: true });
log(`Building ${imageName} from the digest-pinned Containerfile`);
await mustRun(engine, ["build", "--tag", imageName, "--file", "Containerfile", "."]);

try {
  await mustRun(engine, [
    "run",
    "--detach",
    "--name",
    containerName,
    "--publish",
    `127.0.0.1:${port}:3306`,
    "--env",
    "MYSQL_DATABASE=typed_sql_e2e",
    "--env",
    "MYSQL_USER=typed_sql",
    "--env",
    "MYSQL_PASSWORD=typed_sql_e2e",
    "--env",
    "MYSQL_ROOT_PASSWORD=typed_sql_root",
    imageName,
  ]);
  containerStarted = true;
  try {
    await waitForExpectedResult(
      async () => {
        const logs = await run(engine, ["logs", containerName]);
        return `${logs.stdout}${logs.stderr}`.toLowerCase().includes("mysql init process done. ready for start up.");
      },
      true,
      { interval: 250, timeout: 90_000, strict: true },
    );
    await waitForPort(port, { host: "127.0.0.1", timeout: 90_000 });
    await waitForExpectedResult(
      async () => {
        const result = await run(engine, [
          "exec",
          containerName,
          "mysql",
          "--batch",
          "--skip-column-names",
          "--user=typed_sql",
          "--password=typed_sql_e2e",
          "typed_sql_e2e",
          "--execute=SELECT COUNT(*) FROM users",
        ]);
        return result.code === 0 ? result.stdout.trim() : "";
      },
      "2",
      { interval: 250, timeout: 90_000, strict: true },
    );
  } catch (error) {
    const state = await run(engine, ["inspect", "--format", "{{json .State}}", containerName]);
    const logs = await run(engine, ["logs", containerName]);
    throw new Error(
      [
        error instanceof Error ? error.message : String(error),
        `Container state: ${state.stdout}${state.stderr}`,
        `Container logs:\n${logs.stdout}${logs.stderr}`,
      ].join("\n"),
    );
  }

  await describe("developer MySQL flow", async () => {
    await it("generates a package through the public CLI", async () => {
      const result = await cli("generate", "--config", join(packageDirectory, "typed-sql.config.ts"));
      strict.ok(result.stdout.includes("Generated schema"));
      log(`Generated developer package at ${generatedDatabaseDirectory}`);
    });

    await it("shows real catalog introspection in the generated snapshot", async () => {
      const snapshot = JSON.parse(await readFile(generatedSnapshotPath, "utf8")) as GeneratedSnapshot;
      strict.strictEqual(snapshot.dialect, "mysql");
      strict.ok(snapshot.version?.startsWith("8.4.11"));
      strict.strictEqual(snapshot.tables.users?.columns.id?.databaseType, "bigint unsigned");
      strict.strictEqual(snapshot.tables.users?.columns.id?.tsType, "bigint");
      strict.strictEqual(snapshot.tables.users?.columns.status?.tsType, '"active" | "suspended"');
      strict.strictEqual(snapshot.tables.users?.columns.active?.tsType, "boolean");
      strict.strictEqual(snapshot.tables.projects?.columns.budget?.databaseType, "decimal(14,2)");
      strict.strictEqual(snapshot.functions?.["typed_sql_e2e.user_count()"]?.returnType, "bigint");
      strict.strictEqual(snapshot.tables.codec_fidelity?.columns.boolean_value?.tsType, "boolean");
      strict.strictEqual(snapshot.tables.codec_fidelity?.columns.bigint_value?.tsType, "bigint");
      strict.strictEqual(snapshot.tables.codec_fidelity?.columns.decimal_value?.tsType, "string");
      strict.strictEqual(snapshot.tables.codec_fidelity?.columns.bit_value?.tsType, "Uint8Array");
      strict.strictEqual(snapshot.tables.codec_fidelity?.columns.binary_value?.tsType, "Uint8Array");
      strict.strictEqual(snapshot.metadata.schemaHash.length, 64);
      strict.strictEqual(snapshot.metadata.typePolicyHash.length, 64);
    });

    await it("checks exact inferred application types with TypeScript 7", async () => {
      await cli(
        "check",
        "--config",
        join(packageDirectory, "typed-sql.config.ts"),
        "--file",
        join(packageDirectory, "src/query.ts"),
        "--project",
        join(packageDirectory, "tsconfig.json"),
      );
    });

    await it("exposes inferred query types through the TypeScript preview bridge", async () => {
      const sourcePath = join(packageDirectory, "src/query.ts");
      const source = await readFile(sourcePath, "utf8");
      const snapshot = JSON.parse(await readFile(generatedSnapshotPath, "utf8")) as Parameters<typeof analyzeSource>[1];
      const analysis = analyzeSource(source, snapshot as MySqlSchemaSnapshot, mysql());
      const bridge = NativePreviewTypeScriptBridge.spawn({ cwd: workspaceDirectory });
      try {
        const inspections = await bridge.inspectFile({
          fileName: sourcePath,
          projectFile: join(packageDirectory, "tsconfig.json"),
          analysis,
        });
        strict.strictEqual(inspections.length, 3);
        strict.ok(inspections[0]?.typeText.includes('status: "active" | "suspended"'));
        strict.ok(inspections[0]?.typeText.includes("budget: string | null"));
        strict.ok(inspections[1]?.typeText.includes("project_count: bigint | null"));
        strict.ok(inspections[1]?.typeText.includes("total_budget: string | null"));
        strict.strictEqual(
          inspections[2]?.typeText,
          'Query<never, readonly [string, "active" | "suspended", unknown]>',
        );
        strict.ok(inspections.slice(0, 2).every((inspection) => !inspection.typeText.includes("unknown")));
      } finally {
        await bridge.close();
      }
    });

    await it("proves the default MySQL codec matrix at the inferred type boundary", async () => {
      const sourcePath = join(packageDirectory, "src/codec-query.ts");
      const source = await readFile(sourcePath, "utf8");
      const snapshot = JSON.parse(await readFile(generatedSnapshotPath, "utf8")) as Parameters<typeof analyzeSource>[1];
      const analysis = analyzeSource(source, snapshot as MySqlSchemaSnapshot, mysql());
      strict.deepStrictEqual(analysis.diagnostics, []);
      strict.strictEqual(analysis.queries.length, 1);
      const contract = analysis.queries[0]!;
      strict.strictEqual(contract.parameterType, "readonly [number]");
      const rowType = contract.rowType.replace(/"([^"]+)":/gu, "$1:");
      for (const exact of [
        "id: number",
        "boolean_value: boolean",
        "tinyint_value: number",
        "bigint_value: bigint",
        "decimal_value: string",
        "bit_value: Uint8Array",
        "binary_value: Uint8Array",
        "date_value: Date",
        "time_value: string",
        "year_value: number",
        "json_value: unknown",
        'enum_value: "ready" | "waiting"',
        "set_value: string",
        "nullable_text: string | null",
      ])
        strict.ok(rowType.includes(exact), `Missing ${exact} in ${contract.rowType}`);
      const bridge = NativePreviewTypeScriptBridge.spawn({ cwd: workspaceDirectory });
      try {
        const inspections = await bridge.inspectFile({
          fileName: sourcePath,
          projectFile: join(packageDirectory, "tsconfig.json"),
          analysis,
        });
        strict.strictEqual(inspections.length, 1);
        const inferred = inspections[0]!.typeText;
        strict.ok(inferred.startsWith("Query<"));
        strict.ok(inferred.includes("id: number"));
        strict.ok(inferred.includes("bigint_value: bigint"));
        strict.ok(inferred.endsWith("readonly [number]>") || inferred.endsWith("readonly [...]>"));
      } finally {
        await bridge.close();
      }
    });

    await it("matches real mysql2 prepared metadata and decoded runtime rows", async () => {
      const pool = createPool({
        uri: connectionUri,
        supportBigNumbers: true,
        bigNumberStrings: true,
        decimalNumbers: false,
        dateStrings: true,
      });
      try {
        const [rawRows, fields] = await pool.execute(
          `
          WITH project_totals AS (
            SELECT owner_id, COUNT(*) AS project_count, SUM(budget) AS total_budget
            FROM projects GROUP BY owner_id
          )
          SELECT users.id, users.profile->>'$.plan' AS plan,
                 project_totals.project_count, project_totals.total_budget
          FROM users LEFT JOIN project_totals ON project_totals.owner_id = users.id
          WHERE users.id >= ? ORDER BY users.id
        `,
          [1],
        );
        strict.deepStrictEqual(
          fields.map((field) => [field.name, field.columnType]),
          [
            ["id", 8],
            ["plan", 251],
            ["project_count", 8],
            ["total_budget", 246],
          ],
        );
        strict.deepStrictEqual(rawRows, [
          { id: "1", plan: "pro", project_count: "1", total_budget: "12500.50" },
          { id: "2", plan: "free", project_count: null, total_budget: null },
        ]);
      } finally {
        await pool.end();
      }

      const database = await createMySql2Database({ connectionUri, typePolicy });
      try {
        const rows = await database.execute(sql<{
          id: bigint;
          email: string;
          status: "active" | "suspended";
          budget: string | null;
        }>`
          SELECT users.id, users.email, users.status, projects.budget
          FROM users LEFT JOIN projects ON users.id = projects.owner_id ORDER BY users.id
        `);
        strict.deepStrictEqual(rows, [
          { id: 1n, email: "alice@example.com", status: "active", budget: "12500.50" },
          { id: 2n, email: "bob@example.com", status: "suspended", budget: null },
        ]);
        const total = await database.transaction(async (transaction) => {
          const values = await transaction.execute(sql<{ total: bigint }>`SELECT user_count() AS total`);
          return values[0]?.total;
        });
        strict.strictEqual(total, 2n);

        const codecRows = await database.execute(mysqlCodecFidelity);
        const codec = codecRows[0] as Record<string, unknown>;
        strict.strictEqual(codec.id, 1);
        strict.strictEqual(codec.boolean_value, true);
        strict.strictEqual(codec.tinyint_value, 127);
        strict.strictEqual(codec.smallint_value, 32767);
        strict.strictEqual(codec.mediumint_value, 8388607);
        strict.strictEqual(codec.integer_value, 2147483647);
        strict.strictEqual(codec.bigint_value, 9007199254740993n);
        strict.strictEqual(codec.decimal_value, "12345678901234567890.1234567890");
        strict.strictEqual(codec.float_value, 1.25);
        strict.strictEqual(codec.double_value, 2.5);
        strict.ok(codec.bit_value instanceof Uint8Array);
        strict.deepStrictEqual(Array.from(codec.bit_value as Uint8Array), [165]);
        strict.strictEqual(codec.text_value, "codec");
        strict.strictEqual(codec.varchar_value, "typed-sql");
        strict.deepStrictEqual(Array.from(codec.binary_value as Uint8Array), [0, 165, 255]);
        strict.deepStrictEqual(Array.from(codec.blob_value as Uint8Array), [1, 2, 254, 255]);
        strict.ok(codec.date_value instanceof Date);
        strict.ok(codec.datetime_value instanceof Date);
        strict.ok(codec.timestamp_value instanceof Date);
        strict.strictEqual(codec.time_value, "12:34:56");
        strict.strictEqual(codec.year_value, 2026);
        strict.deepStrictEqual(codec.json_value, { count: 1, kind: "json" });
        strict.strictEqual(codec.enum_value, "ready");
        strict.strictEqual(codec.set_value, "read,write");
        strict.strictEqual(codec.nullable_text, null);
      } finally {
        await database.close();
      }
    });

    await it("reports clean drift and detects a real catalog change as TSQ301", async () => {
      const clean = await cli("drift", "--config", join(packageDirectory, "typed-sql.config.ts"));
      strict.ok(clean.stdout.includes("No schema drift detected"));
      await mustRun(engine, [
        "exec",
        containerName,
        "mysql",
        "--user=typed_sql",
        "--password=typed_sql_e2e",
        "typed_sql_e2e",
        "--execute=ALTER TABLE projects ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false",
      ]);
      const changed = await run(process.execPath, [
        cliFile,
        "drift",
        "--config",
        join(packageDirectory, "typed-sql.config.ts"),
      ]);
      strict.strictEqual(changed.code, 1);
      strict.ok(changed.stderr.includes("TSQ301"));
    });
  });
} finally {
  if (containerStarted) await run(engine, ["rm", "--force", containerName]);
}
