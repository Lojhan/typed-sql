import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, it, log, strict, waitForExpectedResult, waitForPort } from "poku";
import type { PostgresDatabase, SqlTag } from "@typed-sql/runtime";
import { analyzeSource } from "@typed-sql/ts-bridge";
import { NativePreviewTypeScriptBridge } from "@typed-sql/ts-bridge/native-preview";

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface GeneratedModule {
  readonly createGeneratedDatabase: (options: { readonly connectionString: string }) => PostgresDatabase;
  readonly sql: SqlTag;
}

interface GeneratedSnapshot {
  readonly dialect: string;
  readonly version?: string;
  readonly tables: Record<string, {
    readonly columns: Record<string, {
      readonly databaseType: string;
      readonly tsType: string;
      readonly nullable: boolean;
      readonly array?: boolean;
    }>;
  }>;
  readonly enums?: Record<string, readonly string[]>;
  readonly domains?: Record<string, { readonly tsType: string }>;
  readonly functions?: Record<string, { readonly returnType: string }>;
  readonly metadata: { readonly schemaHash: string; readonly typePolicyHash: string };
}

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = resolve(packageDirectory, "../..");
const generatedDirectory = join(packageDirectory, "generated");
const generatedDatabaseDirectory = join(generatedDirectory, "db");
const generatedSnapshotPath = join(generatedDatabaseDirectory, "schema.json");
const generatedModulePath = join(generatedDatabaseDirectory, "index.ts");
const engine = process.env.TYPED_SQL_CONTAINER_ENGINE ?? "podman";
const port = Number(process.env.TYPED_SQL_E2E_PORT ?? "55432");
const containerName = `typed-sql-e2e-postgres-${process.pid}`;
const imageName = "localhost/typed-sql-e2e-postgres:18.4";
const connectionString = `postgresql://typed_sql:typed_sql_e2e@127.0.0.1:${port}/typed_sql_e2e`;
let containerStarted = false;

if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new TypeError("TYPED_SQL_E2E_PORT must be an unprivileged TCP port");

function run(command: string, args: readonly string[], cwd = packageDirectory): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
  });
}

async function mustRun(command: string, args: readonly string[], cwd = packageDirectory): Promise<CommandResult> {
  const result = await run(command, args, cwd);
  if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.code})\n${result.stdout}${result.stderr}`);
  return result;
}

const cli = (...args: readonly string[]): Promise<CommandResult> => mustRun("pnpm", ["exec", "typed-sql", ...args]);

await rm(generatedDirectory, { recursive: true, force: true });
log(`Building ${imageName} from the digest-pinned Containerfile`);
await mustRun(engine, ["build", "--tag", imageName, "--file", "Containerfile", "."]);

try {
  await mustRun(engine, [
    "run", "--detach",
    "--name", containerName,
    "--publish", `127.0.0.1:${port}:5432`,
    "--env", "POSTGRES_DB=typed_sql_e2e",
    "--env", "POSTGRES_USER=typed_sql",
    "--env", "POSTGRES_PASSWORD=typed_sql_e2e",
    imageName,
  ]);
  containerStarted = true;
  try {
    await waitForPort(port, { host: "127.0.0.1", timeout: 60_000 });
    await waitForExpectedResult(
      async () => (await run(engine, ["exec", containerName, "pg_isready", "--username", "typed_sql", "--dbname", "typed_sql_e2e"])).code,
      0,
      { interval: 250, timeout: 60_000, strict: true },
    );
  } catch (error) {
    const state = await run(engine, ["inspect", "--format", "{{json .State}}", containerName]);
    const logs = await run(engine, ["logs", containerName]);
    throw new Error([
      error instanceof Error ? error.message : String(error),
      `Container state: ${state.stdout}${state.stderr}`,
      `Container logs:\n${logs.stdout}${logs.stderr}`,
    ].join("\n"));
  }

  await describe("developer PostgreSQL flow", async () => {
    await it("generates a package through the public CLI", async () => {
      const result = await cli(
        "generate", "--provider", "postgres", "--url", connectionString,
        "--schemas", "public", "--out", generatedDatabaseDirectory,
      );
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
      strict.ok(snapshot.metadata.schemaHash.length === 64);
      strict.ok(snapshot.metadata.typePolicyHash.length === 64);
    });

    await it("checks inferred application types with TypeScript 7", async () => {
      await cli(
        "check", "--file", join(packageDirectory, "src/query.ts"),
        "--schema", generatedSnapshotPath,
        "--project", join(packageDirectory, "tsconfig.json"),
      );
    });

    await it("exposes the inferred Query type through the TypeScript preview bridge", async () => {
      const sourcePath = join(packageDirectory, "src/query.ts");
      const source = await readFile(sourcePath, "utf8");
      const snapshot = JSON.parse(await readFile(generatedSnapshotPath, "utf8")) as Parameters<typeof analyzeSource>[1];
      const analysis = analyzeSource(source, snapshot);
      const bridge = NativePreviewTypeScriptBridge.spawn({ cwd: workspaceDirectory });
      try {
        const inspections = await bridge.inspectFile({
          fileName: sourcePath,
          projectFile: join(packageDirectory, "tsconfig.json"),
          analysis,
        });
        strict.ok(inspections[0]?.typeText.startsWith("Query<"));
        strict.ok(inspections[0]?.typeText.includes("status: \"active\" | \"suspended\""));
        strict.ok(inspections[0]?.typeText.includes("budget: string | null"));
        strict.ok(!inspections[0]?.typeText.includes("unknown"));
      } finally {
        await bridge.close();
      }
    });

    await it("executes through the generated runtime package", async () => {
      const generated = await import(`${pathToFileURL(generatedModulePath).href}?run=${Date.now()}`) as GeneratedModule;
      const database = generated.createGeneratedDatabase({ connectionString });
      try {
        const query = generated.sql<{
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
          const result = await transaction.execute(generated.sql<{ total: bigint }>`SELECT active_user_count() AS total`);
          return result[0]?.total;
        });
        strict.strictEqual(total, 1n);
      } finally {
        await database.close();
      }
    });

    await it("reports no drift for the unchanged database", async () => {
      const result = await cli(
        "drift", "--schema", generatedSnapshotPath,
        "--provider", "postgres", "--url", connectionString, "--schemas", "public",
      );
      strict.ok(result.stdout.includes("No schema drift detected"));
    });

    await it("detects a real catalog change as TSQ301", async () => {
      await mustRun(engine, [
        "exec", containerName,
        "psql", "--username", "typed_sql", "--dbname", "typed_sql_e2e",
        "--set", "ON_ERROR_STOP=1",
        "--command", "ALTER TABLE public.projects ADD COLUMN archived boolean NOT NULL DEFAULT false",
      ]);
      const result = await run("pnpm", [
        "exec", "typed-sql", "drift", "--schema", generatedSnapshotPath,
        "--provider", "postgres", "--url", connectionString, "--schemas", "public",
      ]);
      strict.strictEqual(result.code, 1);
      strict.ok(result.stderr.includes("TSQ301"));
    });
  });
} finally {
  if (containerStarted) await run(engine, ["rm", "--force", containerName]);
}
