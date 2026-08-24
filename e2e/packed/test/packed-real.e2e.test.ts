import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, log, strict, waitForExpectedResult, waitForPort } from "poku";

interface CommandResult { readonly code: number; readonly stdout: string; readonly stderr: string }

const execFile = promisify(execFileCallback);
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(packageDirectory, "../..");
const engine = process.env.TYPED_SQL_CONTAINER_ENGINE ?? "podman";
const postgresPort = Number(process.env.TYPED_SQL_PACKED_POSTGRES_PORT ?? "55434");
const mysqlPort = Number(process.env.TYPED_SQL_PACKED_MYSQL_PORT ?? "53308");
const suffix = process.pid;
const postgresContainer = `typed-sql-packed-postgres-${suffix}`;
const mysqlContainer = `typed-sql-packed-mysql-${suffix}`;
const postgresImage = "localhost/typed-sql-e2e-postgres:18.4";
const mysqlImage = "localhost/typed-sql-e2e-mysql:8.4.11";
const packageNames = ["ast", "core", "config", "schema", "compiler", "cli", "postgres", "mysql", "ts-bridge"] as const;
const { NODE_PATH: _nodePath, ...cleanEnvironment } = process.env;
const started: string[] = [];

function run(command: string, args: readonly string[], cwd = workspace): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], { cwd, env: cleanEnvironment, stdio: ["ignore", "pipe", "pipe"] });
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

async function mustRun(command: string, args: readonly string[], cwd = workspace): Promise<CommandResult> {
  const result = await run(command, args, cwd);
  if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.code})\n${result.stdout}${result.stderr}`);
  return result;
}

async function ensureImage(image: string, context: string): Promise<void> {
  if ((await run(engine, ["image", "exists", image])).code === 0) return;
  await mustRun(engine, ["build", "--tag", image, "--file", "Containerfile", "."], context);
}

async function write(path: string, value: string): Promise<void> {
  await writeFile(path, value.trimStart());
}

await describe("packed real-database consumers", async () => {
  await it("generates, typechecks, and executes from tarballs without workspace links", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-packed-real-"));
    const tarballs = join(temporary, "tarballs");
    const consumer = join(temporary, "consumer");
    await mkdir(tarballs);
    await mkdir(consumer);
    try {
      log("Packing public artifacts and building both immutable database images");
      const dependencies: Record<string, string> = {};
      for (const directory of packageNames) {
        const manifest = JSON.parse(await readFile(join(workspace, "packages", directory, "package.json"), "utf8")) as { readonly name: string };
        const before = new Set(await readdir(tarballs));
        await execFile("pnpm", ["--silent", "--filter", manifest.name, "pack", "--pack-destination", tarballs], { cwd: workspace });
        const archive = (await readdir(tarballs)).find((entry) => !before.has(entry));
        if (archive === undefined) throw new Error(`No tarball produced for ${manifest.name}`);
        dependencies[manifest.name] = `file:${join(tarballs, archive)}`;
      }
      const driverLinks = {
        pg: `link:${join(workspace, "node_modules", "pg")}`,
        mysql2: `link:${join(workspace, "node_modules", "mysql2")}`,
        tsx: `link:${join(workspace, "node_modules", "tsx")}`,
        typescript: `link:${join(workspace, "node_modules", "typescript")}`,
        "@types/node": `link:${join(workspace, "node_modules", "@types", "node")}`,
        "@types/pg": `link:${join(workspace, "node_modules", "@types", "pg")}`,
        "@typed-sql/typescript-preview": `link:${join(workspace, "packages", "ts-bridge", "node_modules", "@typed-sql", "typescript-preview")}`,
      };
      await write(join(consumer, "package.json"), `${JSON.stringify({
        private: true,
        type: "module",
        dependencies: { ...dependencies, ...driverLinks },
        pnpm: { overrides: { ...dependencies, ...driverLinks } },
      }, null, 2)}\n`);
      await execFile("pnpm", ["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"], { cwd: consumer, env: { ...cleanEnvironment, CI: "true" } });

      await ensureImage(postgresImage, join(workspace, "e2e", "postgres"));
      await ensureImage(mysqlImage, join(workspace, "e2e", "mysql"));
      await mustRun(engine, ["run", "--detach", "--name", postgresContainer, "--publish", `127.0.0.1:${postgresPort}:5432`, "--env", "POSTGRES_DB=typed_sql_e2e", "--env", "POSTGRES_USER=typed_sql", "--env", "POSTGRES_PASSWORD=typed_sql_e2e", postgresImage]);
      started.push(postgresContainer);
      await mustRun(engine, ["run", "--detach", "--name", mysqlContainer, "--publish", `127.0.0.1:${mysqlPort}:3306`, "--env", "MYSQL_DATABASE=typed_sql_e2e", "--env", "MYSQL_USER=typed_sql", "--env", "MYSQL_PASSWORD=typed_sql_e2e", "--env", "MYSQL_ROOT_PASSWORD=typed_sql_root", mysqlImage]);
      started.push(mysqlContainer);
      await waitForPort(postgresPort, { host: "127.0.0.1", timeout: 90_000 });
      await waitForPort(mysqlPort, { host: "127.0.0.1", timeout: 90_000 });
      await waitForExpectedResult(async () => (await run(engine, ["exec", postgresContainer, "pg_isready", "--username", "typed_sql", "--dbname", "typed_sql_e2e"])).code, 0, { interval: 250, timeout: 90_000, strict: true });
      await waitForExpectedResult(async () => (await run(engine, ["exec", mysqlContainer, "mysqladmin", "ping", "--host=127.0.0.1", "--user=typed_sql", "--password=typed_sql_e2e"])).code, 0, { interval: 250, timeout: 90_000, strict: true });

      for (const name of ["postgres", "mysql"]) await mkdir(join(consumer, name, "src"), { recursive: true });
      await write(join(consumer, "postgres", "typed-sql.config.ts"), `
        import { defineConfig } from "@typed-sql/core";
        import { postgres, typePolicy } from "@typed-sql/postgres";
        import { pg } from "@typed-sql/postgres/pg";
        const dialect = postgres({ typePolicy });
        export default defineConfig({ dialect, schema: { file: "generated/schema.json", provider: pg({ connectionString: "postgresql://typed_sql:typed_sql_e2e@127.0.0.1:${postgresPort}/typed_sql_e2e", schemas: ["public"], typePolicy }) }, outDir: "generated", projects: ["tsconfig.json"], typePolicy });
      `);
      await write(join(consumer, "mysql", "typed-sql.config.ts"), `
        import { defineConfig } from "@typed-sql/core";
        import { mysql, typePolicy } from "@typed-sql/mysql";
        import { mysql2 } from "@typed-sql/mysql/mysql2";
        const dialect = mysql({ typePolicy });
        export default defineConfig({ dialect, schema: { file: "generated/schema.json", provider: mysql2({ connectionUri: "mysql://typed_sql:typed_sql_e2e@127.0.0.1:${mysqlPort}/typed_sql_e2e", schemas: ["typed_sql_e2e"], typePolicy }) }, outDir: "generated", projects: ["tsconfig.json"], typePolicy });
      `);
      const tsconfig = JSON.stringify({ compilerOptions: { strict: true, module: "nodenext", moduleResolution: "nodenext", target: "es2024", types: ["node"], noEmit: true }, include: ["src", "generated", "typed-sql.config.ts"] }, null, 2);
      await write(join(consumer, "postgres", "tsconfig.json"), tsconfig);
      await write(join(consumer, "mysql", "tsconfig.json"), tsconfig);
      const cli = join(consumer, "node_modules", "@typed-sql", "cli", "dist", "packages", "cli", "src", "cli.js");
      for (const name of ["postgres", "mysql"]) await mustRun(process.execPath, [cli, "generate", "--config", join(consumer, name, "typed-sql.config.ts")], join(consumer, name));

      await write(join(consumer, "postgres", "src", "query.ts"), `
        import { sql, typePolicy } from "@typed-sql/postgres";
        import { createPgDatabase } from "@typed-sql/postgres/pg";
        type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
        type Assert<T extends true> = T;
        export const query = sql\`SELECT users.id, users.email FROM users ORDER BY users.id\`;
        async function verifyInferredRows(): Promise<void> {
          const database = await createPgDatabase({ connectionString: "postgresql://unused-at-typecheck", typePolicy });
          const rows = await database.execute(query);
          const exact: Assert<Equal<(typeof rows)[number], { id: bigint; email: string }>> = true;
          void exact;
          await database.close();
        }
        void verifyInferredRows;
      `);
      await write(join(consumer, "mysql", "src", "query.ts"), `
        import { sql, typePolicy } from "@typed-sql/mysql";
        import { createMySql2Database } from "@typed-sql/mysql/mysql2";
        type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
        type Assert<T extends true> = T;
        export const query = sql\`SELECT users.id, users.status FROM users ORDER BY users.id\`;
        async function verifyInferredRows(): Promise<void> {
          const database = await createMySql2Database({ connectionUri: "mysql://unused-at-typecheck", typePolicy });
          const rows = await database.execute(query);
          const exact: Assert<Equal<(typeof rows)[number], { id: bigint; status: "active" | "suspended" }>> = true;
          void exact;
          await database.close();
        }
        void verifyInferredRows;
      `);
      for (const name of ["postgres", "mysql"]) await mustRun(process.execPath, [cli, "check", "--config", join(consumer, name, "typed-sql.config.ts"), "--file", join(consumer, name, "src", "query.ts"), "--project", join(consumer, name, "tsconfig.json")], join(consumer, name));

      await write(join(consumer, "inspect-preview.ts"), `
        import { readFile } from "node:fs/promises";
        import { join } from "node:path";
        import { mysql } from "@typed-sql/mysql";
        import { postgres } from "@typed-sql/postgres";
        import { analyzeSource } from "@typed-sql/ts-bridge";
        import { NativePreviewTypeScriptBridge } from "@typed-sql/ts-bridge/native-preview";
        const cases = [
          { name: "postgres", dialect: postgres(), expected: ["id: bigint", "email: string"] },
          { name: "mysql", dialect: mysql(), expected: ["id: bigint", 'status: "active" | "suspended"'] },
        ] as const;
        const bridge = NativePreviewTypeScriptBridge.spawn({ cwd: ${JSON.stringify(consumer)} });
        try {
          for (const item of cases) {
            const directory = join(${JSON.stringify(consumer)}, item.name);
            const fileName = join(directory, "src", "query.ts");
            const source = await readFile(fileName, "utf8");
            const schema = JSON.parse(await readFile(join(directory, "generated", "schema.json"), "utf8"));
            const analysis = analyzeSource(source, schema, item.dialect as never);
            const inspections = await bridge.inspectFile({ fileName, projectFile: join(directory, "tsconfig.json"), analysis });
            const typeText = inspections[0]?.typeText ?? "";
            if (!typeText.startsWith("Query<") || typeText.includes("unknown") || !item.expected.every((part) => typeText.includes(part))) {
              throw new Error(\`packed preview inference failed for \${item.name}: \${typeText}\`);
            }
          }
        } finally {
          await bridge.close();
        }
      `);
      await mustRun(process.execPath, ["--import", "tsx", join(consumer, "inspect-preview.ts")], consumer);

      await write(join(consumer, "verify.ts"), `
        import { sql as postgresSql, typePolicy as postgresTypePolicy } from "@typed-sql/postgres";
        import { createPgDatabase } from "@typed-sql/postgres/pg";
        import { sql as mysqlSql, typePolicy as mysqlTypePolicy } from "@typed-sql/mysql";
        import { createMySql2Database } from "@typed-sql/mysql/mysql2";
        const postgres = await createPgDatabase({ connectionString: "postgresql://typed_sql:typed_sql_e2e@127.0.0.1:${postgresPort}/typed_sql_e2e", typePolicy: postgresTypePolicy });
        const mysql = await createMySql2Database({ connectionUri: "mysql://typed_sql:typed_sql_e2e@127.0.0.1:${mysqlPort}/typed_sql_e2e", typePolicy: mysqlTypePolicy });
        try {
          const pgRows = await postgres.execute(postgresSql<{ id: bigint; email: string }>\`SELECT id, email FROM users ORDER BY id\`);
          const myRows = await mysql.execute(mysqlSql<{ id: bigint; status: string }>\`SELECT id, status FROM users ORDER BY id\`);
          if (pgRows[0]?.id !== 1n || pgRows[0]?.email !== "alice@example.com") throw new Error("packed pg execution failed");
          if (myRows[0]?.id !== 1n || myRows[0]?.status !== "active") throw new Error("packed mysql2 execution failed");
        } finally { await postgres.close(); await mysql.close(); }
      `);
      await mustRun(process.execPath, ["--import", "tsx", join(consumer, "verify.ts")], consumer);
      strict.ok(true);
    } finally {
      for (const container of started.reverse()) await run(engine, ["rm", "--force", container]);
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
