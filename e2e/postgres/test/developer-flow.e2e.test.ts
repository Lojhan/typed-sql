import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFORMANCE_VERSION,
  type ConformanceLiveAdapter,
  type ConformanceServerErrorClass,
  type ConformanceTypeNormalizer,
  createConformanceReport,
  createConformanceReproductionBundle,
  defineConformanceProbe,
  runLiveConformanceProbe,
  runStaticConformanceProbe,
  selectExpectedOutcome,
  serializeConformanceReport,
  serializeConformanceReproductionBundle,
} from "@typed-sql/conformance/v2";
import {
  type DatabaseObserver,
  type DatabaseOperationEnd,
  type DatabaseOperationStart,
  requireAdapterCapability,
} from "@typed-sql/core";
import { createPostgresRoutedDatabase, postgres, postgresCopy, sql, typePolicy } from "@typed-sql/postgres";
import { createPgDatabase, createPgLiveVerifier } from "@typed-sql/postgres/pg";
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
  readonly formatVersion: 2;
  readonly dialect: string;
  readonly server: { readonly version: string };
  readonly relations: Record<
    string,
    {
      readonly columns: Record<
        string,
        {
          readonly databaseType: string;
          readonly tsType: string;
          readonly nullable: boolean;
          readonly dimensions?: readonly number[];
        }
      >;
    }
  >;
  readonly types: Record<string, { readonly tsType: string; readonly labels?: readonly string[] }>;
  readonly routines: Record<string, readonly { readonly result: { readonly tsType?: string } }[]>;
  readonly metadata: { readonly schemaHash: string; readonly typePolicyHash: string };
}

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = resolve(packageDirectory, "../..");
const pgCursorPackage: string = "pg-cursor";
const pgCopyStreamsPackage: string = "pg-copy-streams";
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
await rm(join(packageDirectory, ".typed-sql"), { recursive: true, force: true });
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
      strict.strictEqual(snapshot.formatVersion, 2);
      strict.strictEqual(snapshot.dialect, "postgres");
      strict.ok(snapshot.server.version.startsWith("18.4"));
      strict.strictEqual(snapshot.relations.users?.columns.id?.databaseType, "bigint");
      strict.strictEqual(snapshot.relations.users?.columns.id?.tsType, "bigint");
      strict.strictEqual(snapshot.relations.users?.columns.email?.tsType, "string");
      strict.strictEqual(snapshot.relations.projects?.columns.budget?.databaseType, "numeric(14,2)");
      strict.strictEqual(snapshot.relations.projects?.columns.budget?.tsType, "string");
      strict.deepStrictEqual(snapshot.relations.projects?.columns.tags?.dimensions, []);
      strict.deepStrictEqual(snapshot.types.account_status?.labels, ["active", "suspended"]);
      strict.strictEqual(snapshot.types.email_address?.tsType, "string");
      strict.strictEqual(snapshot.routines.active_user_count?.[0]?.result.tsType, "bigint");
      strict.strictEqual(snapshot.relations.codec_fidelity?.columns.id?.tsType, "number");
      strict.strictEqual(snapshot.relations.codec_fidelity?.columns.bigint_value?.tsType, "bigint");
      strict.strictEqual(snapshot.relations.codec_fidelity?.columns.numeric_value?.tsType, "string");
      strict.strictEqual(snapshot.relations.codec_fidelity?.columns.binary_value?.tsType, "Uint8Array");
      strict.strictEqual(snapshot.relations.codec_fidelity?.columns.bigint_array?.tsType, "readonly (bigint)[]");
      strict.ok(snapshot.metadata.schemaHash.length === 64);
      strict.ok(snapshot.metadata.typePolicyHash.length === 64);
    });

    await it("records a redacted conformance v2 differential report", async () => {
      const snapshotValue = postgres().validateSnapshot(JSON.parse(await readFile(generatedSnapshotPath, "utf8")));
      if (snapshotValue.formatVersion !== 2) throw new TypeError("PostgreSQL conformance requires snapshot v2");
      if (snapshotValue.metadata === undefined)
        throw new TypeError("The generated PostgreSQL snapshot requires metadata");
      const dialect = postgres();
      const query = sql`SELECT id FROM users WHERE id = ${1n}`;
      const verifier = createPgLiveVerifier({ connectionString, schema: snapshotValue, typePolicy });
      const database = await createPgDatabase({ connectionString, typePolicy });
      const server = await verifier.server();
      const target = {
        grammar: "postgres",
        grammarVersion: dialect.grammarVersion,
        databaseVersion: server.version,
      } as const;
      const probe = defineConformanceProbe({
        version: CONFORMANCE_VERSION,
        id: "postgres.statement.select.live-bigint",
        featureId: "statement.select",
        grammar: "postgres",
        targets: [target],
        source: "SELECT id FROM users WHERE id = $1",
        schemaFixture: "e2e/postgres/schema/catalog.snapshot.json",
        query,
        compilerSource:
          'import { sql } from "@typed-sql/postgres";\nexport const query = sql`SELECT id FROM users WHERE id = ${1n}`;',
        live: { prepare: true, execute: true, maximumRows: 1 },
        expected: [
          {
            target: { grammarVersion: dialect.grammarVersion, databaseVersion: server.version },
            support: "conservative",
            rows: [
              {
                name: "id",
                tsType: "bigint",
                nullable: false,
                databaseType: "bigint",
                range: { start: 7, end: 9, line: 1, column: 8 },
              },
            ],
            parameters: [{ index: 1, tsType: "bigint", nullable: false, databaseType: "bigint" }],
            diagnostics: [],
            rendered: { text: "SELECT id FROM users WHERE id = $1", values: [1n] },
            compiled: { rowType: '{ "id": bigint; }', parameterType: "readonly [bigint]" },
            decodedRows: [{ id: 1n }],
            skips: { "lex-parse": "grammar-parser-private", plan: "plan-format-unstable" },
          },
        ],
      });
      const requestedProbe = process.env.TYPED_SQL_CONFORMANCE_PROBE;
      if (requestedProbe !== undefined && requestedProbe !== probe.id) {
        throw new TypeError(`PostgreSQL live suite does not contain requested probe ${requestedProbe}`);
      }
      const requestedDatabaseVersion = process.env.TYPED_SQL_CONFORMANCE_DATABASE_VERSION;
      if (requestedDatabaseVersion !== undefined && requestedDatabaseVersion !== server.version) {
        throw new TypeError(`Requested PostgreSQL ${requestedDatabaseVersion}, connected to ${server.version}`);
      }
      const requestedFixtureGroup = process.env.TYPED_SQL_CONFORMANCE_FIXTURE_GROUP;
      if (requestedFixtureGroup !== undefined && requestedFixtureGroup !== "statement.select") {
        throw new TypeError(`PostgreSQL live suite does not contain fixture group ${requestedFixtureGroup}`);
      }
      const adapter: ConformanceLiveAdapter = {
        grammar: "postgres",
        driver: "pg",
        driverVersion: "8.23.0",
        async server() {
          return {
            version: server.version,
            capabilities: Object.fromEntries((server.features ?? []).map((feature) => [feature, true])),
          };
        },
        async prepare(request) {
          const evidence = await verifier.verify({
            fingerprint: `sha256:${createHash("sha256").update(request.probeId).digest("hex")}`,
            sql: request.sql,
            operation: "read",
          });
          const field = (value: (typeof evidence.columns)[number]) => ({
            index: value.index,
            ...(value.name === undefined ? {} : { name: value.name }),
            ...(value.databaseType === undefined ? {} : { nativeType: value.databaseType }),
            ...(value.nullable === undefined ? {} : { nullable: value.nullable }),
          });
          return {
            columns: evidence.columns.map(field),
            parameters: evidence.parameters.map(field),
            ...(evidence.unavailable === undefined ? {} : { unavailable: evidence.unavailable }),
          };
        },
        execute: async () => database.execute(query),
        classify(error): ConformanceServerErrorClass {
          const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
          if (code === "42601") return "syntax";
          if (code === "42P01" || code === "42703") return "schema";
          if (code === "42501") return "privilege";
          if (code === "57014") return "timeout";
          if (code.startsWith("08")) return "environment";
          return "semantic";
        },
        async cleanup() {},
        async close() {
          await verifier.close();
          await database.close();
        },
      };
      const normalizer: ConformanceTypeNormalizer = {
        column: (field) => ({
          name: field.name ?? "id",
          tsType: "bigint",
          nullable: field.nullable ?? false,
          databaseType: field.nativeType ?? "bigint",
        }),
        parameter: (field) => ({
          index: field.index,
          tsType: "bigint",
          nullable: field.nullable ?? false,
          databaseType: field.nativeType ?? "bigint",
        }),
      };
      try {
        const staticResult = runStaticConformanceProbe(probe, target, {
          dialect,
          snapshot: snapshotValue,
          renderer: {
            placeholder: (index) => dialect.placeholder(index),
            quoteIdentifier: (identifier) => dialect.quoteIdentifier(identifier),
          },
        });
        const result = await runLiveConformanceProbe(probe, target, adapter, normalizer, staticResult);
        const report = createConformanceReport(
          "postgres-live",
          {
            grammar: "postgres",
            grammarVersion: dialect.grammarVersion,
            databaseVersion: server.version,
            driver: "pg",
            driverVersion: "8.23.0",
            runtime: "node",
            runtimeVersion: process.version,
            typescriptVersion: "7.0.2",
            schemaFingerprint: `sha256:${snapshotValue.metadata.schemaHash}`,
            capabilities: Object.fromEntries((server.features ?? []).map((feature) => [feature, true])),
          },
          [result],
        );
        const artifactDirectory = join(workspaceDirectory, "artifacts", "conformance");
        await mkdir(artifactDirectory, { recursive: true });
        const serialized = serializeConformanceReport(report);
        strict.ok(!serialized.includes(connectionString));
        strict.ok(!serialized.includes("1n"));
        await writeFile(join(artifactDirectory, "postgres.json"), serialized);
        if (result.status !== "pass") {
          const reproduction = createConformanceReproductionBundle(
            probe,
            target,
            report.environment,
            selectExpectedOutcome(probe, target),
            result,
          );
          await writeFile(
            join(artifactDirectory, "postgres-reproduction.json"),
            serializeConformanceReproductionBundle(reproduction),
          );
        }
        strict.strictEqual(result.status, "pass", JSON.stringify(result, null, 2));
      } finally {
        await adapter.close();
      }
    });

    await it("proves compiled metadata through PostgreSQL PREPARE without executing values", async () => {
      const project = join(packageDirectory, "tsconfig.verify.json");
      await cli("manifest", "--config", join(packageDirectory, "typed-sql.config.ts"), "--project", project);
      const live = await cli(
        "verify",
        "--live",
        "--config",
        join(packageDirectory, "typed-sql.config.ts"),
        "--project",
        project,
      );
      strict.match(live.stdout, /Verified 2 variants \(0 mismatched, 0 skipped, 0 failed\)/u);
      const proof = await readFile(join(packageDirectory, ".typed-sql", "verification.json"), "utf8");
      strict.ok(!proof.includes("SELECT users"));
      strict.ok(!proof.includes(connectionString));
      const cached = await cli("verify", "--config", join(packageDirectory, "typed-sql.config.ts"));
      strict.match(cached.stdout, /Cached verification is current/u);
      const explained = await cli(
        "explain",
        "--config",
        join(packageDirectory, "typed-sql.config.ts"),
        "--project",
        project,
      );
      strict.match(explained.stdout, /Captured 2 plans \(0 skipped, 0 failed\)/u);
      const plans = await readFile(join(packageDirectory, ".typed-sql", "plans.json"), "utf8");
      strict.match(plans, /Index Scan|Seq Scan/u);
      strict.ok(!plans.includes("SELECT users"));
      strict.ok(!plans.includes(connectionString));
      const safetyPool = new Pool({ connectionString });
      try {
        const safety = await safetyPool.query<{ readonly email: string }>("SELECT email FROM users WHERE id = 1");
        strict.strictEqual(safety.rows[0]?.email, "alice@example.com");
      } finally {
        await safetyPool.end();
      }
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
      const dialect = postgres();
      const snapshot = dialect.validateSnapshot(JSON.parse(await readFile(generatedSnapshotPath, "utf8")) as unknown);
      const analysis = analyzeSource(source, snapshot, dialect);
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
      const dialect = postgres();
      const snapshot = dialect.validateSnapshot(JSON.parse(await readFile(generatedSnapshotPath, "utf8")) as unknown);
      const analysis = analyzeSource(source, snapshot, dialect);
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
      const dialect = postgres();
      const snapshot = dialect.validateSnapshot(JSON.parse(await readFile(generatedSnapshotPath, "utf8")) as unknown);
      const analysis = analyzeSource(source, snapshot, dialect);
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

    await it("routes real PostgreSQL reads conservatively and preserves transaction affinity", async () => {
      const snapshot = postgres().validateSnapshot(JSON.parse(await readFile(generatedSnapshotPath, "utf8")));
      const primary = await createPgDatabase({ connectionString, typePolicy });
      const replica = await createPgDatabase({ connectionString, typePolicy });
      const routes: string[] = [];
      const database = createPostgresRoutedDatabase({
        primary,
        replicas: [replica],
        schema: snapshot,
        observer: {
          route: ({ route, primaryPinned }) => routes.push(`${route}:${primaryPinned}`),
        },
      });
      const read = sql<{ id: bigint }>`SELECT id FROM users ORDER BY id`;
      const lockingRead = sql<{ id: bigint }>`SELECT id FROM users ORDER BY id FOR UPDATE`;
      const write = sql<never>`UPDATE users SET email = email WHERE id = ${-1n}`;
      try {
        const lockingContext = database.context();
        strict.deepStrictEqual(await lockingContext.all(read), [{ id: 1n }, { id: 2n }]);
        strict.deepStrictEqual(await lockingContext.all(lockingRead), [{ id: 1n }, { id: 2n }]);
        await lockingContext.all(read);

        const writeContext = database.context();
        await writeContext.execute(write);
        await writeContext.all(read);

        await database.context().transaction(async (transaction) => {
          strict.deepStrictEqual(await transaction.all(read), [{ id: 1n }, { id: 2n }]);
        });

        strict.deepStrictEqual(routes, [
          "replica:false",
          "primary:true",
          "primary:true",
          "primary:true",
          "primary:true",
          "primary:true",
        ]);
      } finally {
        await primary.close();
        await replica.close();
      }
    });

    await it("enforces cardinality and discards interrupted pg connections", async () => {
      const completions: DatabaseOperationEnd[] = [];
      const database = await createPgDatabase({
        connectionString,
        typePolicy,
        poolConfig: { max: 1, connectionTimeoutMillis: 2_000 },
        observer: {
          start() {
            return { end: (completion) => completions.push(completion) };
          },
        },
      });
      try {
        const account = await database.one(sql<{ id: bigint }>`SELECT id FROM users WHERE id = ${1n}`);
        strict.deepStrictEqual(account, { id: 1n });
        strict.strictEqual(
          await database.maybeOne(sql<{ id: bigint }>`SELECT id FROM users WHERE id = ${-1n}`),
          undefined,
        );
        await strict.rejects(database.one(sql<{ id: bigint }>`SELECT id FROM users WHERE id = ${-1n}`), (error) => {
          strict.strictEqual((error as { code?: unknown }).code, "TSQL_CARDINALITY");
          strict.strictEqual((error as { actual?: unknown }).actual, 0);
          return true;
        });

        await strict.rejects(database.all(sql<never>`SELECT pg_sleep(10)`, { deadline: Date.now() + 50 }), (error) => {
          strict.strictEqual((error as { code?: unknown }).code, "TSQL_CANCELLED");
          strict.strictEqual((error as { reason?: unknown }).reason, "deadline");
          return true;
        });
        strict.deepStrictEqual(await database.one(sql<{ value: bigint }>`SELECT 1::bigint AS value`), { value: 1n });

        const controller = new AbortController();
        const cancelledTransaction = database.transaction(async (transaction) => {
          const running = transaction.all(sql<never>`SELECT pg_sleep(10)`, { signal: controller.signal });
          setTimeout(() => controller.abort(), 50);
          return running;
        });
        await strict.rejects(cancelledTransaction, (error) => {
          strict.strictEqual((error as { code?: unknown }).code, "TSQL_CANCELLED");
          return true;
        });
        strict.deepStrictEqual(await database.one(sql<{ value: bigint }>`SELECT 2::bigint AS value`), { value: 2n });
        strict.ok(
          completions.some(
            ({ status, errorType, cancellationReason }) =>
              status === "cancelled" && errorType === "TSQL_CANCELLED" && cancellationReason === "deadline",
          ),
        );
        strict.ok(
          completions.some(
            ({ status, errorType, cancellationReason }) =>
              status === "cancelled" && errorType === "TSQL_CANCELLED" && cancellationReason === "signal",
          ),
        );
        strict.ok(completions.every((completion) => !("cause" in completion)));
      } finally {
        await database.close();
      }
    });

    await it("batches and streams inferred and prepared queries through a reusable one-client pool", async () => {
      const observationStarts: DatabaseOperationStart[] = [];
      const observationEnds: DatabaseOperationEnd[] = [];
      const observer: DatabaseObserver = {
        start(operation) {
          observationStarts.push(operation);
          return { end: (completion) => observationEnds.push(completion) };
        },
      };
      const database = await createPgDatabase({
        connectionString,
        typePolicy,
        observer,
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
        const kinds = new Set(observationStarts.map(({ kind }) => kind));
        for (const kind of ["query", "batch", "pipeline", "stream", "transaction"] as const) {
          strict.ok(kinds.has(kind), `Missing real PostgreSQL ${kind} observation`);
        }
        strict.strictEqual(observationEnds.length, observationStarts.length);
        strict.ok(observationEnds.every(({ status }) => status === "success"));
        for (const operation of observationStarts) {
          strict.ok(!("text" in operation));
          strict.ok(!("values" in operation));
          strict.ok(!("connectionString" in operation));
        }
      } finally {
        await database.close();
      }
    });

    await it("imports and exports typed rows through application-owned PostgreSQL COPY", async () => {
      const database = await createPgDatabase({
        connectionString,
        typePolicy,
        poolConfig: { max: 1, connectionTimeoutMillis: 2_000 },
        copyStreamsImporter: () => import(pgCopyStreamsPackage),
      });
      try {
        await database.execute(sql`
          CREATE TABLE bulk_accounts (
            id BIGINT PRIMARY KEY,
            email TEXT NOT NULL,
            note TEXT
          )
        `);
        const copy = requireAdapterCapability(database, postgresCopy);
        const rowQuery = (row: { readonly id: bigint; readonly email: string; readonly note: string | null }) =>
          sql`INSERT INTO bulk_accounts (id, email, note) VALUES (${row.id}, ${row.email}, ${row.note})`;
        const imported = await copy.copyFrom(rowQuery, [
          { id: 1n, email: "one@example.com", note: null },
          { id: 2n, email: 'two,"quoted"@example.com', note: "line\nbreak" },
        ]);
        strict.strictEqual(imported.rows, 2);
        strict.ok(imported.bytes > 0);

        await database.transaction(async (transaction) => {
          const transactionalCopy = requireAdapterCapability(transaction, postgresCopy);
          await transactionalCopy.copyFrom(rowQuery, [{ id: 3n, email: "three@example.com", note: "committed" }]);
        });

        const exported: Uint8Array[] = [];
        for await (const chunk of copy.copyTo(sql`SELECT id, email, note FROM bulk_accounts ORDER BY id`)) {
          exported.push(chunk);
        }
        strict.strictEqual(
          new TextDecoder().decode(Buffer.concat(exported)),
          '1,one@example.com,\n2,"two,""quoted""@example.com","line\nbreak"\n3,three@example.com,committed\n',
        );

        const producerError = new Error("producer failed");
        async function* failedRows() {
          yield { id: 4n, email: "four@example.com", note: null };
          throw producerError;
        }
        await strict.rejects(() => copy.copyFrom(rowQuery, failedRows()), producerError);
        strict.deepStrictEqual(
          await database.execute(sql<{ readonly total: bigint }>`SELECT COUNT(*) AS total FROM bulk_accounts`),
          [{ total: 3n }],
        );
        await database.execute(sql`DROP TABLE bulk_accounts`);
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
