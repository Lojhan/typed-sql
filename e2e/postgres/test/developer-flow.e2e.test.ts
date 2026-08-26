import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type PostgresSchemaSnapshot, postgres, sql, typePolicy } from "@typed-sql/postgres";
import { createPgDatabase } from "@typed-sql/postgres/pg";
import { analyzeSource } from "@typed-sql/ts-bridge";
import { NativePreviewTypeScriptBridge } from "@typed-sql/ts-bridge/native-preview";
import { Pool } from "pg";
import { describe, it, log, strict, waitForExpectedResult, waitForPort } from "poku";
import { postgresCodecFidelity } from "../src/codec-query.js";
import { postgresAccountStream, postgresAccountsAtOrAbove } from "../src/stream-query.js";

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
        {
          readonly databaseType: string;
          readonly tsType: string;
          readonly nullable: boolean;
          readonly array?: boolean;
        }
      >;
    }
  >;
  readonly enums?: Record<string, readonly string[]>;
  readonly domains?: Record<string, { readonly tsType: string }>;
  readonly functions?: Record<string, { readonly returnType: string }>;
  readonly metadata: { readonly schemaHash: string; readonly typePolicyHash: string };
}

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = resolve(packageDirectory, "../..");
const pgCursorPackage: string = "pg-cursor";
const generatedDirectory = join(packageDirectory, "generated");
const generatedDatabaseDirectory = join(generatedDirectory, "db");
const generatedSnapshotPath = join(generatedDatabaseDirectory, "schema.json");
const cliFile = join(workspaceDirectory, "packages", "cli", "dist", "packages", "cli", "src", "cli.js");
const engine = process.env.TYPED_SQL_CONTAINER_ENGINE ?? "podman";
const port = Number(process.env.TYPED_SQL_E2E_PORT ?? "55432");
const containerName = `typed-sql-e2e-postgres-${process.pid}`;
const imageName = "localhost/typed-sql-e2e-postgres:18.4";
const connectionString = `postgresql://typed_sql:typed_sql_e2e@127.0.0.1:${port}/typed_sql_e2e`;
let containerStarted = false;

if (!Number.isInteger(port) || port < 1024 || port > 65_535)
  throw new TypeError("TYPED_SQL_E2E_PORT must be an unprivileged TCP port");

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
    `127.0.0.1:${port}:5432`,
    "--env",
    "POSTGRES_DB=typed_sql_e2e",
    "--env",
    "POSTGRES_USER=typed_sql",
    "--env",
    "POSTGRES_PASSWORD=typed_sql_e2e",
    imageName,
  ]);
  containerStarted = true;
  try {
    const initializationComplete = "PostgreSQL init process complete; ready for start up.";
    const acceptingConnections = "database system is ready to accept connections";
    await waitForExpectedResult(
      async () => {
        const logs = await run(engine, ["logs", containerName]);
        const output = `${logs.stdout}${logs.stderr}`;
        const initializationIndex = output.lastIndexOf(initializationComplete);
        return (
          initializationIndex >= 0 && output.indexOf(acceptingConnections, initializationIndex) > initializationIndex
        );
      },
      true,
      { interval: 250, timeout: 60_000, strict: true },
    );
    await waitForPort(port, { host: "127.0.0.1", timeout: 60_000 });
    await waitForExpectedResult(
      async () => {
        const result = await run(engine, [
          "exec",
          containerName,
          "psql",
          "--username",
          "typed_sql",
          "--dbname",
          "typed_sql_e2e",
          "--tuples-only",
          "--no-align",
          "--command",
          "SELECT count(*) FROM public.users",
        ]);
        return result.code === 0 ? result.stdout.trim() : "";
      },
      "2",
      { interval: 250, timeout: 60_000, strict: true },
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

  await describe("developer PostgreSQL flow", async () => {
    await it("generates a package through the public CLI", async () => {
      const result = await cli("generate", "--config", join(packageDirectory, "typed-sql.config.ts"));
      strict.ok(result.stdout.includes("Generated schema"));
      log(`Generated developer package at ${generatedDatabaseDirectory}`);
    });

    await it("shows real catalog introspection in the generated snapshot", async () => {
      const snapshot = JSON.parse(await readFile(generatedSnapshotPath, "utf8")) as GeneratedSnapshot;
      strict.strictEqual(snapshot.dialect, "postgres");
      strict.ok(snapshot.version?.startsWith("18.4"));
      strict.strictEqual(snapshot.tables.users?.columns.id?.databaseType, "bigint");
      strict.strictEqual(snapshot.tables.users?.columns.id?.tsType, "bigint");
      strict.strictEqual(snapshot.tables.users?.columns.email?.tsType, "string");
      strict.strictEqual(snapshot.tables.projects?.columns.budget?.databaseType, "numeric(14,2)");
      strict.strictEqual(snapshot.tables.projects?.columns.budget?.tsType, "string");
      strict.strictEqual(snapshot.tables.projects?.columns.tags?.array, true);
      strict.deepStrictEqual(snapshot.enums?.account_status, ["active", "suspended"]);
      strict.strictEqual(snapshot.domains?.email_address?.tsType, "string");
      strict.strictEqual(snapshot.functions?.["active_user_count()"]?.returnType, "bigint");
      strict.strictEqual(snapshot.tables.codec_fidelity?.columns.id?.tsType, "number");
      strict.strictEqual(snapshot.tables.codec_fidelity?.columns.bigint_value?.tsType, "bigint");
      strict.strictEqual(snapshot.tables.codec_fidelity?.columns.numeric_value?.tsType, "string");
      strict.strictEqual(snapshot.tables.codec_fidelity?.columns.binary_value?.tsType, "Uint8Array");
      strict.strictEqual(snapshot.tables.codec_fidelity?.columns.bigint_array?.tsType, "readonly (bigint)[]");
      strict.ok(snapshot.metadata.schemaHash.length === 64);
      strict.ok(snapshot.metadata.typePolicyHash.length === 64);
    });

    await it("checks inferred application types with TypeScript 7", async () => {
      await cli(
        "check",
        "--config",
        join(packageDirectory, "typed-sql.config.ts"),
        "--file",
        join(packageDirectory, "src/query.ts"),
        "--project",
        join(packageDirectory, "tsconfig.json"),
      );
      await cli(
        "check",
        "--config",
        join(packageDirectory, "typed-sql.config.ts"),
        "--file",
        join(packageDirectory, "src/stream-query.ts"),
        "--project",
        join(packageDirectory, "tsconfig.json"),
      );
    });

    await it("exposes the inferred Query type through the TypeScript preview bridge", async () => {
      const sourcePath = join(packageDirectory, "src/query.ts");
      const source = await readFile(sourcePath, "utf8");
      const snapshot = JSON.parse(await readFile(generatedSnapshotPath, "utf8")) as Parameters<typeof analyzeSource>[1];
      const analysis = analyzeSource(source, snapshot as PostgresSchemaSnapshot, postgres());
      const bridge = NativePreviewTypeScriptBridge.spawn({ cwd: workspaceDirectory });
      try {
        const inspections = await bridge.inspectFile({
          fileName: sourcePath,
          projectFile: join(packageDirectory, "tsconfig.json"),
          analysis,
        });
        strict.ok(inspections[0]?.typeText.startsWith("Query<"));
        strict.ok(inspections[0]?.typeText.includes('status: "active" | "suspended"'));
        strict.ok(inspections[0]?.typeText.includes("budget: string | null"));
        strict.ok(!inspections[0]?.typeText.includes("unknown"));
        strict.strictEqual(inspections.length, 4);
        strict.ok(inspections[1]?.typeText.includes("plan: string | null"));
        strict.ok(inspections[1]?.typeText.includes("project_count: bigint | null"));
        strict.ok(inspections[1]?.typeText.includes("total_budget: string | null"));
        strict.ok(!inspections[1]?.typeText.includes("unknown"));
        strict.ok(inspections[2]?.typeText.includes("id: bigint"));
        strict.ok(inspections[2]?.typeText.includes('status: "active" | "suspended"'));
        strict.ok(!inspections[2]?.typeText.includes("unknown"));
        strict.strictEqual(inspections[3]?.typeText, "Query<never, readonly [unknown, bigint]>");
      } finally {
        await bridge.close();
      }
    });

    await it("infers the same queries used by the prepared and streaming runtime flow", async () => {
      const sourcePath = join(packageDirectory, "src/stream-query.ts");
      const source = await readFile(sourcePath, "utf8");
      const snapshot = JSON.parse(await readFile(generatedSnapshotPath, "utf8")) as Parameters<typeof analyzeSource>[1];
      const analysis = analyzeSource(source, snapshot as PostgresSchemaSnapshot, postgres());
      strict.deepStrictEqual(analysis.diagnostics, []);
      strict.strictEqual(analysis.queries.length, 2);
      const bridge = NativePreviewTypeScriptBridge.spawn({ cwd: workspaceDirectory });
      try {
        const inspections = await bridge.inspectFile({
          fileName: sourcePath,
          projectFile: join(packageDirectory, "tsconfig.json"),
          analysis,
        });
        strict.strictEqual(inspections.length, 2);
        strict.ok(inspections[0]?.typeText.includes("id: bigint"));
        strict.ok(inspections[0]?.typeText.includes("budget: string | null"));
        strict.ok(!inspections[0]?.typeText.includes("unknown"));
        strict.ok(inspections[1]?.typeText.includes("id: bigint"));
        strict.ok(inspections[1]?.typeText.includes("email: string"));
        strict.ok(inspections[1]?.typeText.includes('status: "active" | "suspended"'));
        strict.ok(inspections[1]?.typeText.includes("readonly [bigint]"));
        strict.ok(!inspections[1]?.typeText.includes("unknown"));
      } finally {
        await bridge.close();
      }
    });

    await it("proves the default PostgreSQL codec matrix at the inferred type boundary", async () => {
      const sourcePath = join(packageDirectory, "src/codec-query.ts");
      const source = await readFile(sourcePath, "utf8");
      const snapshot = JSON.parse(await readFile(generatedSnapshotPath, "utf8")) as Parameters<typeof analyzeSource>[1];
      const analysis = analyzeSource(source, snapshot as PostgresSchemaSnapshot, postgres());
      strict.deepStrictEqual(analysis.diagnostics, []);
      strict.strictEqual(analysis.queries.length, 1);
      const contract = analysis.queries[0]!;
      strict.strictEqual(contract.parameterType, "readonly [number]");
      const rowType = contract.rowType.replace(/"([^"]+)":/gu, "$1:");
      for (const exact of [
        "id: number",
        "smallint_value: number",
        "integer_value: number",
        "bigint_value: bigint",
        "numeric_value: string",
        "boolean_value: boolean",
        "uuid_value: string",
        "date_value: Date",
        "json_value: unknown",
        "binary_value: Uint8Array",
        "bigint_array: readonly (bigint)[]",
        "numeric_array: readonly (string)[]",
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

    await it("matches prepared PostgreSQL result metadata for advanced inferred queries", async () => {
      const pool = new Pool({ connectionString });
      try {
        const result = await pool.query({
          name: "typed-sql-project-totals",
          text: `
            WITH project_totals AS (
              SELECT owner_id, COUNT(*) AS project_count, SUM(budget) AS total_budget
              FROM projects
              GROUP BY owner_id
            )
            SELECT users.id,
                   users.profile->>'plan' AS plan,
                   project_totals.project_count,
                   project_totals.total_budget
            FROM users
            LEFT JOIN project_totals ON project_totals.owner_id = users.id
            WHERE users.id >= $1
            ORDER BY users.id
          `,
          values: [1],
        });
        strict.deepStrictEqual(
          result.fields.map((field) => [field.name, field.dataTypeID]),
          [
            ["id", 20],
            ["plan", 25],
            ["project_count", 20],
            ["total_budget", 1700],
          ],
        );
        strict.deepStrictEqual(result.rows, [
          { id: "1", plan: "pro", project_count: "1", total_budget: "12500.50" },
          { id: "2", plan: "free", project_count: null, total_budget: null },
        ]);
      } finally {
        await pool.end();
      }
    });

    await it("executes through the dialect package tag and application-owned pg adapter", async () => {
      const database = await createPgDatabase({ connectionString, typePolicy });
      try {
        const query = sql<{
          id: bigint;
          email: string;
          status: "active" | "suspended";
          budget: string | null;
        }>`
          SELECT user_account.id,
                 user_account.email,
                 user_account.status,
                 project.budget::NUMERIC AS budget
          FROM users AS user_account
          LEFT JOIN projects AS project ON user_account.id = project.owner_id
          ORDER BY user_account.id
        `;
        const rows = await database.execute(query);
        strict.deepStrictEqual(rows, [
          { id: 1n, email: "alice@example.com", status: "active", budget: "12500.50" },
          { id: 2n, email: "bob@example.com", status: "suspended", budget: null },
        ]);
        const total = await database.transaction(async (transaction) => {
          const result = await transaction.execute(sql<{ total: bigint }>`SELECT active_user_count() AS total`);
          return result[0]?.total;
        });
        strict.strictEqual(total, 1n);

        const aggregateRows = await database.execute(sql<{
          id: bigint;
          plan: string | null;
          project_count: bigint | null;
          total_budget: string | null;
        }>`
          WITH project_totals AS (
            SELECT owner_id, COUNT(*) AS project_count, SUM(budget) AS total_budget
            FROM projects
            GROUP BY owner_id
          )
          SELECT users.id,
                 users.profile->>'plan' AS plan,
                 project_totals.project_count,
                 project_totals.total_budget
          FROM users
          LEFT JOIN project_totals ON project_totals.owner_id = users.id
          ORDER BY users.id
        `);
        strict.deepStrictEqual(aggregateRows, [
          { id: 1n, plan: "pro", project_count: 1n, total_budget: "12500.50" },
          { id: 2n, plan: "free", project_count: null, total_budget: null },
        ]);

        const inserted = await database.transaction(async (transaction) => {
          const created = await transaction.execute(sql<{
            id: bigint;
            email: string;
            status: "active" | "suspended";
          }>`
            INSERT INTO users (email, status)
            VALUES (${`transaction-${process.pid}@example.com`}, ${"active"}::account_status)
            RETURNING id, email, status
          `);
          const changed = await transaction.execute(sql<{ id: bigint; plan: string | null }>`
            UPDATE users
            SET profile = ${'{"plan":"enterprise"}'}::jsonb
            WHERE id = ${created[0]!.id}
            RETURNING id, profile->>'plan' AS plan
          `);
          strict.deepStrictEqual(changed, [{ id: created[0]!.id, plan: "enterprise" }]);
          return created[0]!;
        });
        strict.strictEqual(inserted.status, "active");

        const deleted = await database.execute(sql<{ id: bigint }>`
          DELETE FROM users WHERE id = ${inserted.id} RETURNING id
        `);
        strict.deepStrictEqual(deleted, [{ id: inserted.id }]);

        const codecRows = await database.execute(postgresCodecFidelity);
        const codec = codecRows[0] as Record<string, unknown>;
        strict.strictEqual(codec.id, 1);
        strict.strictEqual(codec.smallint_value, 32767);
        strict.strictEqual(codec.integer_value, 2147483647);
        strict.strictEqual(codec.bigint_value, 9007199254740993n);
        strict.strictEqual(codec.numeric_value, "12345678901234567890.1234567890");
        strict.strictEqual(codec.real_value, 1.25);
        strict.strictEqual(codec.double_value, 2.5);
        strict.strictEqual(codec.boolean_value, true);
        strict.strictEqual(codec.text_value, "codec");
        strict.strictEqual(codec.uuid_value, "22222222-2222-2222-2222-222222222222");
        strict.ok(codec.date_value instanceof Date);
        strict.ok(codec.timestamp_value instanceof Date);
        strict.ok(codec.timestamptz_value instanceof Date);
        strict.deepStrictEqual(codec.json_value, { kind: "json", count: 1 });
        strict.deepStrictEqual(codec.jsonb_value, { enabled: true, kind: "jsonb" });
        strict.ok(codec.binary_value instanceof Uint8Array);
        strict.deepStrictEqual(Array.from(codec.binary_value as Uint8Array), [0, 165, 255]);
        strict.deepStrictEqual(codec.bigint_array, [1n, 9007199254740993n]);
        strict.deepStrictEqual(codec.numeric_array, ["1.25", "12345678901234567890.1234567890"]);
        strict.deepStrictEqual(codec.text_array, ["one", "two"]);
        strict.strictEqual(codec.nullable_text, null);
      } finally {
        await database.close();
      }
    });

    await it("batches and streams inferred and prepared queries through a reusable one-client pool", async () => {
      const database = await createPgDatabase({
        connectionString,
        typePolicy,
        poolConfig: { max: 1, connectionTimeoutMillis: 2_000, pipeline: true },
        // The workspace package is symlinked outside this fixture's node_modules tree. Supplying
        // the application-owned loader preserves pnpm's strict dependency boundary in this E2E.
        cursorImporter: () => import(pgCursorPackage),
      });
      try {
        const accountAtOrAbove = database.prepare("e2e-account-at-or-above", postgresAccountsAtOrAbove);
        strict.strictEqual(accountAtOrAbove.statementName, "e2e-account-at-or-above");

        const preparedQuery = accountAtOrAbove(1n);
        const preparedRows = await database.execute(preparedQuery);
        strict.deepStrictEqual(preparedRows, [
          { id: 1n, email: "alice@example.com", status: "active" },
          { id: 2n, email: "bob@example.com", status: "suspended" },
        ]);

        const [batchPreparedRows, batchInferredRows] = await database.batch([
          accountAtOrAbove(2n),
          postgresAccountStream,
        ]);
        strict.deepStrictEqual(batchPreparedRows, [{ id: 2n, email: "bob@example.com", status: "suspended" }]);
        strict.deepStrictEqual(batchInferredRows, [
          {
            id: 1n,
            email: "alice@example.com",
            status: "active",
            budget: "12500.50",
          },
          { id: 2n, email: "bob@example.com", status: "suspended", budget: null },
        ]);

        const [pipelinePreparedRows, pipelineInferredRows] = await database.pipeline([
          accountAtOrAbove(2n),
          postgresAccountStream,
        ]);
        strict.deepStrictEqual(pipelinePreparedRows, [{ id: 2n, email: "bob@example.com", status: "suspended" }]);
        strict.deepStrictEqual(pipelineInferredRows, batchInferredRows);

        const inferredRows: unknown[] = [];
        for await (const row of database.stream(postgresAccountStream, { batchSize: 1 })) inferredRows.push(row);
        strict.deepStrictEqual(inferredRows, [
          {
            id: 1n,
            email: "alice@example.com",
            status: "active",
            budget: "12500.50",
          },
          { id: 2n, email: "bob@example.com", status: "suspended", budget: null },
        ]);

        const early = database.stream(accountAtOrAbove(1n), { batchSize: 1 });
        for await (const row of early) {
          strict.deepStrictEqual(row, { id: 1n, email: "alice@example.com", status: "active" });
          break;
        }

        strict.deepStrictEqual(await database.execute(accountAtOrAbove(2n)), [
          { id: 2n, email: "bob@example.com", status: "suspended" },
        ]);

        const transactionFirst = await database.transaction(async (transaction) => {
          const stream = transaction.stream(accountAtOrAbove(1n), { batchSize: 1 });
          let first: unknown;
          for await (const row of stream) {
            first = row;
            break;
          }
          const stillUsable = await transaction.execute(accountAtOrAbove(2n));
          strict.deepStrictEqual(stillUsable, [{ id: 2n, email: "bob@example.com", status: "suspended" }]);
          const [transactionPreparedRows, transactionHealth] = await transaction.batch([
            accountAtOrAbove(1n),
            sql<{ total: bigint }>`SELECT active_user_count() AS total`,
          ]);
          strict.deepStrictEqual(transactionPreparedRows, [
            { id: 1n, email: "alice@example.com", status: "active" },
            { id: 2n, email: "bob@example.com", status: "suspended" },
          ]);
          strict.deepStrictEqual(transactionHealth, [{ total: 1n }]);
          return first;
        });
        strict.deepStrictEqual(transactionFirst, {
          id: 1n,
          email: "alice@example.com",
          status: "active",
        });

        const health = await database.execute(sql<{ total: bigint }>`SELECT active_user_count() AS total`);
        strict.deepStrictEqual(health, [{ total: 1n }]);
      } finally {
        await database.close();
      }
    });

    await it("reports no drift for the unchanged database", async () => {
      const result = await cli("drift", "--config", join(packageDirectory, "typed-sql.config.ts"));
      strict.ok(result.stdout.includes("No schema drift detected"));
    });

    await it("detects a real catalog change as TSQ301", async () => {
      await mustRun(engine, [
        "exec",
        containerName,
        "psql",
        "--username",
        "typed_sql",
        "--dbname",
        "typed_sql_e2e",
        "--set",
        "ON_ERROR_STOP=1",
        "--command",
        "ALTER TABLE public.projects ADD COLUMN archived boolean NOT NULL DEFAULT false",
      ]);
      const result = await run(process.execPath, [
        cliFile,
        "drift",
        "--config",
        join(packageDirectory, "typed-sql.config.ts"),
      ]);
      strict.strictEqual(result.code, 1);
      strict.ok(result.stderr.includes("TSQ301"));
    });
  });
} finally {
  if (containerStarted) await run(engine, ["rm", "--force", containerName]);
}
