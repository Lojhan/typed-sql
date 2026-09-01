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
  type Query,
  requireAdapterCapability,
} from "@typed-sql/core";
import { createMySqlRoutedDatabase, mysql, mysqlBulk, sql, typePolicy } from "@typed-sql/mysql";
import { createMySql2Database, createMySql2LiveVerifier } from "@typed-sql/mysql/mysql2";
import { analyzeSource } from "@typed-sql/ts-bridge";
import { NativePreviewTypeScriptBridge } from "@typed-sql/ts-bridge/native-preview";
import { createPool } from "mysql2/promise";
import { describe, it, log, strict, waitForExpectedResult, waitForPort } from "poku";
import { mysqlCodecFidelity } from "../src/codec-query.js";
import { streamAccountsQuery } from "../src/stream-query.js";

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
        { readonly databaseType: string; readonly tsType: string; readonly nullable: boolean }
      >;
    }
  >;
  readonly routines: Record<string, readonly { readonly result: { readonly tsType?: string } }[]>;
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
    "--local-infile=ON",
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
      strict.strictEqual(snapshot.formatVersion, 2);
      strict.strictEqual(snapshot.dialect, "mysql");
      strict.ok(snapshot.server.version.startsWith("8.4.11"));
      strict.strictEqual(snapshot.relations.users?.columns.id?.databaseType, "bigint unsigned");
      strict.strictEqual(snapshot.relations.users?.columns.id?.tsType, "bigint");
      strict.strictEqual(snapshot.relations.users?.columns.status?.tsType, '"active" | "suspended"');
      strict.strictEqual(snapshot.relations.users?.columns.active?.tsType, "boolean");
      strict.strictEqual(snapshot.relations.projects?.columns.budget?.databaseType, "decimal(14,2)");
      strict.strictEqual(snapshot.routines["typed_sql_e2e.user_count"]?.[0]?.result.tsType, "bigint");
      strict.strictEqual(snapshot.relations.codec_fidelity?.columns.boolean_value?.tsType, "boolean");
      strict.strictEqual(snapshot.relations.codec_fidelity?.columns.bigint_value?.tsType, "bigint");
      strict.strictEqual(snapshot.relations.codec_fidelity?.columns.decimal_value?.tsType, "string");
      strict.strictEqual(snapshot.relations.codec_fidelity?.columns.bit_value?.tsType, "Uint8Array");
      strict.strictEqual(snapshot.relations.codec_fidelity?.columns.binary_value?.tsType, "Uint8Array");
      strict.strictEqual(snapshot.metadata.schemaHash.length, 64);
      strict.strictEqual(snapshot.metadata.typePolicyHash.length, 64);
    });

    await it("records a redacted conformance v2 differential report", async () => {
      const snapshotValue = mysql().validateSnapshot(JSON.parse(await readFile(generatedSnapshotPath, "utf8")));
      if (snapshotValue.formatVersion !== 2) throw new TypeError("MySQL conformance requires snapshot v2");
      if (snapshotValue.metadata === undefined) throw new TypeError("The generated MySQL snapshot requires metadata");
      const dialect = mysql();
      const query = sql`SELECT id FROM users WHERE id = ${1n}`;
      const verifier = createMySql2LiveVerifier({ connectionUri, schema: snapshotValue, typePolicy });
      const database = await createMySql2Database({ connectionUri, typePolicy });
      const server = await verifier.server();
      const target = {
        grammar: "mysql",
        grammarVersion: dialect.grammarVersion,
        databaseVersion: server.version,
      } as const;
      const probe = defineConformanceProbe({
        version: CONFORMANCE_VERSION,
        id: "mysql.statement.select.live-bigint",
        featureId: "statement.select",
        grammar: "mysql",
        targets: [target],
        source: "SELECT id FROM users WHERE id = ?",
        schemaFixture: "e2e/mysql/schema/catalog.snapshot.json",
        query,
        compilerSource:
          'import { sql } from "@typed-sql/mysql";\nexport const query = sql`SELECT id FROM users WHERE id = ${1n}`;',
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
                databaseType: "bigint unsigned",
                range: { start: 7, end: 9, line: 1, column: 8 },
              },
            ],
            parameters: [{ index: 1, tsType: "bigint", nullable: false, databaseType: "bigint unsigned" }],
            diagnostics: [],
            rendered: { text: "SELECT id FROM users WHERE id = ?", values: [1n] },
            compiled: { rowType: '{ "id": bigint; }', parameterType: "readonly [bigint]" },
            decodedRows: [{ id: 1n }],
            skips: { "lex-parse": "grammar-parser-private", plan: "plan-format-unstable" },
          },
        ],
      });
      const requestedProbe = process.env.TYPED_SQL_CONFORMANCE_PROBE;
      if (requestedProbe !== undefined && requestedProbe !== probe.id) {
        throw new TypeError(`MySQL live suite does not contain requested probe ${requestedProbe}`);
      }
      const requestedDatabaseVersion = process.env.TYPED_SQL_CONFORMANCE_DATABASE_VERSION;
      if (requestedDatabaseVersion !== undefined && requestedDatabaseVersion !== server.version) {
        throw new TypeError(`Requested MySQL ${requestedDatabaseVersion}, connected to ${server.version}`);
      }
      const requestedFixtureGroup = process.env.TYPED_SQL_CONFORMANCE_FIXTURE_GROUP;
      if (requestedFixtureGroup !== undefined && requestedFixtureGroup !== "statement.select") {
        throw new TypeError(`MySQL live suite does not contain fixture group ${requestedFixtureGroup}`);
      }
      const adapter: ConformanceLiveAdapter = {
        grammar: "mysql",
        driver: "mysql2",
        driverVersion: "3.24.1",
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
          if (code === "ER_PARSE_ERROR") return "syntax";
          if (code === "ER_NO_SUCH_TABLE" || code === "ER_BAD_FIELD_ERROR") return "schema";
          if (code === "ER_TABLEACCESS_DENIED_ERROR" || code === "ER_ACCESS_DENIED_ERROR") return "privilege";
          if (code === "PROTOCOL_SEQUENCE_TIMEOUT") return "timeout";
          if (code.startsWith("PROTOCOL_") || code === "ECONNRESET") return "environment";
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
          databaseType: "bigint unsigned",
        }),
        parameter: (field) => ({
          index: field.index,
          tsType: "bigint",
          nullable: false,
          databaseType: "bigint unsigned",
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
          "mysql-live",
          {
            grammar: "mysql",
            grammarVersion: dialect.grammarVersion,
            databaseVersion: server.version,
            driver: "mysql2",
            driverVersion: "3.24.1",
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
        strict.ok(!serialized.includes(connectionUri));
        strict.ok(!serialized.includes("1n"));
        await writeFile(join(artifactDirectory, "mysql.json"), serialized);
        if (result.status !== "pass") {
          const reproduction = createConformanceReproductionBundle(
            probe,
            target,
            report.environment,
            selectExpectedOutcome(probe, target),
            result,
          );
          await writeFile(
            join(artifactDirectory, "mysql-reproduction.json"),
            serializeConformanceReproductionBundle(reproduction),
          );
        }
        strict.strictEqual(result.status, "pass", JSON.stringify(result, null, 2));
      } finally {
        await adapter.close();
      }
    });

    await it("proves compiled metadata through COM_STMT_PREPARE without executing values", async () => {
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
      strict.ok(!proof.includes(connectionUri));
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
      strict.match(plans, /access:/u);
      strict.ok(!plans.includes("SELECT users"));
      strict.ok(!plans.includes(connectionUri));
      strict.ok(!plans.includes("e2e-representative-v1"));
      const safetyPool = createPool({ uri: connectionUri });
      try {
        const [safety] = await safetyPool.query("SELECT email FROM users WHERE id = 1");
        strict.strictEqual((safety as Array<{ readonly email: string }>)[0]?.email, "alice@example.com");
      } finally {
        await safetyPool.end();
      }
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
      const dialect = mysql();
      const snapshot = dialect.validateSnapshot(JSON.parse(await readFile(generatedSnapshotPath, "utf8")) as unknown);
      const analysis = analyzeSource(source, snapshot, dialect);
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

        const streamSourcePath = join(packageDirectory, "src/stream-query.ts");
        const streamSource = await readFile(streamSourcePath, "utf8");
        const streamAnalysis = analyzeSource(streamSource, snapshot, dialect);
        const streamInspections = await bridge.inspectFile({
          fileName: streamSourcePath,
          projectFile: join(packageDirectory, "tsconfig.json"),
          analysis: streamAnalysis,
        });
        strict.strictEqual(streamInspections.length, 1);
        strict.ok(streamInspections[0]?.typeText.includes("id: bigint"));
        strict.ok(streamInspections[0]?.typeText.includes('status: "active" | "suspended"'));
        strict.ok(streamInspections[0]?.typeText.includes("budget: string | null"));
      } finally {
        await bridge.close();
      }
    });

    await it("proves the default MySQL codec matrix at the inferred type boundary", async () => {
      const sourcePath = join(packageDirectory, "src/codec-query.ts");
      const source = await readFile(sourcePath, "utf8");
      const dialect = mysql();
      const snapshot = dialect.validateSnapshot(JSON.parse(await readFile(generatedSnapshotPath, "utf8")) as unknown);
      const analysis = analyzeSource(source, snapshot, dialect);
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

    await it("routes real MySQL reads conservatively and preserves transaction affinity", async () => {
      const snapshot = mysql().validateSnapshot(JSON.parse(await readFile(generatedSnapshotPath, "utf8")));
      const primary = await createMySql2Database({ connectionUri, typePolicy });
      const replica = await createMySql2Database({ connectionUri, typePolicy });
      const routes: string[] = [];
      const database = createMySqlRoutedDatabase({
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

    await it("enforces cardinality and discards interrupted mysql2 connections", async () => {
      const completions: DatabaseOperationEnd[] = [];
      const database = await createMySql2Database({
        connectionUri,
        typePolicy,
        poolConfig: { connectionLimit: 1 },
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

        await strict.rejects(database.all(sql<never>`SELECT SLEEP(10)`, { deadline: Date.now() + 50 }), (error) => {
          strict.strictEqual((error as { code?: unknown }).code, "TSQL_CANCELLED");
          strict.strictEqual((error as { reason?: unknown }).reason, "deadline");
          return true;
        });
        strict.deepStrictEqual(await database.one(sql<{ value: bigint }>`SELECT 1 AS value`), { value: 1n });

        const controller = new AbortController();
        const cancelledTransaction = database.transaction(async (transaction) => {
          const running = transaction.all(sql<never>`SELECT SLEEP(10)`, { signal: controller.signal });
          setTimeout(() => controller.abort(), 50);
          return running;
        });
        await strict.rejects(cancelledTransaction, (error) => {
          strict.strictEqual((error as { code?: unknown }).code, "TSQL_CANCELLED");
          return true;
        });
        strict.deepStrictEqual(await database.one(sql<{ value: bigint }>`SELECT 2 AS value`), { value: 2n });
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

    await it("streams an inferred prepared query and leaves real mysql2 connections reusable", async () => {
      type Account = {
        id: bigint;
        email: string;
        status: "active" | "suspended";
        budget: string | null;
      };
      // The preceding preview-bridge check proves this exact source binding's inferred type. The
      // ordinary E2E tsc pass does not install the preview bridge, so retain that verified type at
      // the harness boundary while exercising the original immutable Query object at runtime.
      const accountsQuery = streamAccountsQuery as unknown as Query<Account, readonly []>;
      const observationStarts: DatabaseOperationStart[] = [];
      const observationEnds: DatabaseOperationEnd[] = [];
      const observer: DatabaseObserver = {
        start(operation) {
          observationStarts.push(operation);
          return { end: (completion) => observationEnds.push(completion) };
        },
      };
      const database = await createMySql2Database({ connectionUri, typePolicy, observer });
      try {
        const preparedAccounts = database.prepare("e2e-accounts", () => accountsQuery);
        strict.strictEqual(preparedAccounts.statementName, "e2e-accounts");

        const firstRows: Array<{ id: bigint; email: string }> = [];
        for await (const row of database.stream(preparedAccounts(), { batchSize: 1 })) {
          firstRows.push({ id: row.id, email: row.email });
          break;
        }
        strict.deepStrictEqual(firstRows, [{ id: 1n, email: "alice@example.com" }]);

        const countAfterBreak = await database.execute(sql<{ total: bigint }>`SELECT user_count() AS total`);
        strict.strictEqual(countAfterBreak[0]?.total, 2n);

        const allRows: Account[] = [];
        for await (const row of database.stream(preparedAccounts(), { batchSize: 1 })) allRows.push(row);
        strict.deepStrictEqual(allRows, [
          { id: 1n, email: "alice@example.com", status: "active", budget: "12500.50" },
          { id: 2n, email: "bob@example.com", status: "suspended", budget: null },
        ]);

        const [batchedAccounts, batchedTotals, commandRows] = await database.batch([
          preparedAccounts(),
          sql<{ total: bigint }>`SELECT user_count() AS total`,
          sql<never>`UPDATE users SET active = active WHERE id = -1`,
        ]);
        strict.deepStrictEqual(batchedAccounts, allRows);
        strict.strictEqual(batchedTotals[0]?.total, 2n);
        strict.deepStrictEqual(commandRows, []);

        const transactionResult = await database.transaction(async (transaction) => {
          for await (const row of transaction.stream(preparedAccounts(), { batchSize: 1 })) {
            strict.strictEqual(row.id, 1n);
            break;
          }
          const [accounts, totals] = await transaction.batch([
            preparedAccounts(),
            sql<{ total: bigint }>`SELECT user_count() AS total`,
          ]);
          return { accountCount: accounts.length, total: totals[0]?.total };
        });
        strict.deepStrictEqual(transactionResult, { accountCount: 2, total: 2n });

        const rowsAfterTransaction = await database.execute(preparedAccounts());
        strict.strictEqual(rowsAfterTransaction.length, 2);
        strict.strictEqual(rowsAfterTransaction[1]?.status, "suspended");
        const kinds = new Set(observationStarts.map(({ kind }) => kind));
        for (const kind of ["query", "batch", "stream", "transaction"] as const) {
          strict.ok(kinds.has(kind), `Missing real MySQL ${kind} observation`);
        }
        strict.strictEqual(observationEnds.length, observationStarts.length);
        strict.ok(observationEnds.every(({ status }) => status === "success"));
        for (const operation of observationStarts) {
          strict.ok(!("text" in operation));
          strict.ok(!("values" in operation));
          strict.ok(!("connectionUri" in operation));
        }
      } finally {
        await database.close();
      }
    });

    await it("loads typed rows through mysql2's application-owned local infile stream", async () => {
      const database = await createMySql2Database({
        connectionUri,
        typePolicy,
        poolConfig: { connectionLimit: 1 },
      });
      try {
        await database.execute(sql`
          CREATE TABLE bulk_accounts (
            id BIGINT PRIMARY KEY,
            email VARCHAR(255) NOT NULL,
            note TEXT
          )
        `);
        const bulk = requireAdapterCapability(database, mysqlBulk);
        const rowQuery = (row: { readonly id: bigint; readonly email: string; readonly note: string | null }) =>
          sql`INSERT INTO bulk_accounts (id, email, note) VALUES (${row.id}, ${row.email}, ${row.note})`;
        const loaded = await bulk.loadData(rowQuery, [
          { id: 1n, email: "one@example.com", note: null },
          { id: 2n, email: "two\texample.com", note: "line\nbreak\\tail" },
        ]);
        strict.strictEqual(loaded.rows, 2);
        strict.ok(loaded.bytes > 0);

        await database.transaction(async (transaction) => {
          await requireAdapterCapability(transaction, mysqlBulk).loadData(rowQuery, [
            { id: 3n, email: "three@example.com", note: "committed" },
          ]);
        });

        strict.deepStrictEqual(
          await database.execute(
            sql<{
              readonly id: bigint;
              readonly email: string;
              readonly note: string | null;
            }>`SELECT id, email, note FROM bulk_accounts ORDER BY id`,
          ),
          [
            { id: 1n, email: "one@example.com", note: null },
            { id: 2n, email: "two\texample.com", note: "line\nbreak\\tail" },
            { id: 3n, email: "three@example.com", note: "committed" },
          ],
        );

        const producerError = new Error("producer failed");
        async function* failedRows() {
          yield { id: 4n, email: "four@example.com", note: null };
          throw producerError;
        }
        await strict.rejects(() => bulk.loadData(rowQuery, failedRows()), producerError);
        strict.deepStrictEqual(
          await database.execute(sql<{ readonly total: bigint }>`SELECT COUNT(*) AS total FROM bulk_accounts`),
          [{ total: 3n }],
        );
        await database.execute(sql`DROP TABLE bulk_accounts`);
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
