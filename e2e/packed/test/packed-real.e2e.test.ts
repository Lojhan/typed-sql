import { execFile as execFileCallback, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, it, log, strict, waitForExpectedResult, waitForPort } from "poku";
import { ProtocolClient, positionAt } from "../../../test/helpers/protocol-client.js";

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

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
const packageNames = [
  "ast",
  "core",
  "config",
  "schema",
  "compiler",
  "cli",
  "postgres",
  "mysql",
  "sqlite",
  "ts-bridge",
  "language-server",
] as const;
const previewPackageNames = new Set(["@typed-sql/ts-bridge", "@typed-sql/language-server"]);
const dialectNames = ["postgres", "mysql", "sqlite"] as const;
const artifactParameterSentinel = "typed-sql-packed-parameter-sentinel";
const artifactCredentialSentinel = "typed-sql-packed-credential-sentinel";
const consumerSource = process.env.TYPED_SQL_CONSUMER_SOURCE ?? "packed";
const registryOnly = consumerSource === "registry";
const registryTag = process.env.TYPED_SQL_REGISTRY_TAG ?? "next";
const registryPreviewTag = process.env.TYPED_SQL_REGISTRY_PREVIEW_TAG ?? "next";
const registryExpected = process.env.TYPED_SQL_REGISTRY_EXPECTED || undefined;
if (!registryOnly && consumerSource !== "packed") {
  throw new Error(`TYPED_SQL_CONSUMER_SOURCE must be packed or registry, received ${consumerSource}`);
}
if (registryExpected !== undefined && registryExpected !== "workspace") {
  throw new Error(`TYPED_SQL_REGISTRY_EXPECTED must be workspace when set, received ${registryExpected}`);
}
const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
const requiresExperimentalSqlite = nodeMajor === 22 && nodeMinor < 13;
const { NODE_PATH: _nodePath, ...environmentWithoutNodePath } = process.env;
const cleanEnvironment = {
  ...environmentWithoutNodePath,
  ...(requiresExperimentalSqlite
    ? { NODE_OPTIONS: [process.env.NODE_OPTIONS, "--experimental-sqlite"].filter(Boolean).join(" ") }
    : {}),
};
const started: string[] = [];

function run(command: string, args: readonly string[], cwd = workspace): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], { cwd, env: cleanEnvironment, stdio: ["ignore", "pipe", "pipe"] });
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

async function mustRun(command: string, args: readonly string[], cwd = workspace): Promise<CommandResult> {
  const result = await run(command, args, cwd);
  if (result.code !== 0)
    throw new Error(`${command} ${args.join(" ")} failed (${result.code})\n${result.stdout}${result.stderr}`);
  return result;
}

async function mustEventuallyRun(
  command: string,
  args: readonly string[],
  cwd: string,
  timeout = 180_000,
): Promise<CommandResult> {
  const deadline = Date.now() + timeout;
  let result = await run(command, args, cwd);
  while (result.code !== 0 && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
    result = await run(command, args, cwd);
  }
  if (result.code === 0) return result;
  throw new Error(`${command} ${args.join(" ")} failed (${result.code})\n${result.stdout}${result.stderr}`);
}

async function ensureImage(image: string, context: string): Promise<void> {
  if ((await run(engine, ["image", "exists", image])).code === 0) return;
  await mustRun(engine, ["build", "--tag", image, "--file", "Containerfile", "."], context);
}

async function write(path: string, value: string): Promise<void> {
  await writeFile(path, value.trimStart());
}

async function packLocalDependency(directory: string, tarballs: string): Promise<string> {
  const before = new Set(await readdir(tarballs));
  await execFile("pnpm", ["--silent", "pack", "--pack-destination", tarballs], { cwd: directory });
  const archive = (await readdir(tarballs)).find((entry) => !before.has(entry));
  if (archive === undefined) throw new Error(`No tarball produced for local dependency ${directory}`);
  return `file:${join(tarballs, archive)}`;
}

async function readPackageVersion(directory: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
    readonly version: string;
  };
  return manifest.version;
}

async function packTypescriptPlatformDependency(directory: string, tarballs: string): Promise<string> {
  const manifestPath = join(directory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    readonly name: string;
    readonly version: string;
  };
  const staging = join(tarballs, `typescript-platform-${manifest.version}`);
  await cp(directory, staging, { recursive: true });
  await writeFile(
    join(staging, "package.json"),
    `${JSON.stringify(
      {
        ...manifest,
        // TypeScript's published platform archive marks this native executable directly. Repacking
        // its installed directory does not, so declare a fixture-only bin to preserve executable mode.
        bin: { [`typed-sql-typescript-platform-${manifest.version}`]: "./lib/tsc" },
      },
      null,
      2,
    )}\n`,
  );
  return packLocalDependency(staging, tarballs);
}

async function typescriptFixture(directory: string, tarballs: string) {
  const installedDirectory = await realpath(directory);
  const platformPackageName = `@typescript/typescript-${process.platform}-${process.arch}`;
  const platformDirectory = join(dirname(installedDirectory), ...platformPackageName.split("/"));
  return {
    package: await packLocalDependency(installedDirectory, tarballs),
    platformPackage: await packTypescriptPlatformDependency(platformDirectory, tarballs),
    version: await readPackageVersion(installedDirectory),
  };
}

async function assertPortableArtifact(path: string, checkout: string): Promise<string> {
  const source = await readFile(path, "utf8");
  JSON.parse(source);
  for (const forbidden of [
    checkout,
    workspace,
    "postgresql://",
    "mysql://",
    artifactCredentialSentinel,
    "typed_sql_root",
    "127.0.0.1",
    artifactParameterSentinel,
  ]) {
    strict.ok(!source.includes(forbidden), `${path} contains forbidden artifact data: ${forbidden}`);
  }
  return source;
}

await describe(`${consumerSource} real-database consumers`, async () => {
  await it(`generates, typechecks, and executes from ${registryOnly ? `npm ${registryTag}` : "tarballs"}`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), `typed-sql-${consumerSource}-real-`));
    const tarballs = join(temporary, "tarballs");
    const consumer = join(temporary, "consumer");
    await mkdir(tarballs);
    await mkdir(consumer);
    try {
      log(
        `${registryOnly ? `Resolving npm ${registryTag} with preview tooling from ${registryPreviewTag}` : "Packing public artifacts"} and building both immutable database images`,
      );
      const dependencies: Record<string, string> = {};
      for (const directory of packageNames) {
        const manifest = JSON.parse(await readFile(join(workspace, "packages", directory, "package.json"), "utf8")) as {
          readonly name: string;
          readonly version: string;
        };
        if (registryOnly) {
          const sourceTag = previewPackageNames.has(manifest.name) ? registryPreviewTag : registryTag;
          dependencies[manifest.name] =
            registryExpected === "workspace" && sourceTag === registryTag ? manifest.version : sourceTag;
        } else {
          const before = new Set(await readdir(tarballs));
          await execFile("pnpm", ["--silent", "--filter", manifest.name, "pack", "--pack-destination", tarballs], {
            cwd: workspace,
          });
          const archive = (await readdir(tarballs)).find((entry) => !before.has(entry));
          if (archive === undefined) throw new Error(`No tarball produced for ${manifest.name}`);
          dependencies[manifest.name] = `file:${join(tarballs, archive)}`;
        }
      }
      const localTypescript = registryOnly
        ? undefined
        : {
            stable: await typescriptFixture(join(workspace, "node_modules", "typescript"), tarballs),
            preview: await typescriptFixture(
              join(workspace, "packages", "ts-bridge", "node_modules", "@typed-sql", "typescript-preview"),
              tarballs,
            ),
          };
      const typescriptPlatformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;
      const driverLinks = registryOnly
        ? {
            pg: "8.23.0",
            mysql2: "3.24.1",
            valibot: "1.4.2",
            zod: "4.5.2",
            tsx: "4.23.12",
            typescript: "7.0.2",
            "@types/node": "24.13.3",
          }
        : {
            pg: `link:${join(workspace, "node_modules", "pg")}`,
            mysql2: `link:${join(workspace, "node_modules", "mysql2")}`,
            valibot: `link:${join(packageDirectory, "node_modules", "valibot")}`,
            zod: `link:${join(packageDirectory, "node_modules", "zod")}`,
            tsx: `link:${join(workspace, "node_modules", "tsx")}`,
            typescript: localTypescript!.stable.package,
            "@types/node": `link:${join(workspace, "node_modules", "@types", "node")}`,
            "@types/pg": `link:${join(workspace, "node_modules", "@types", "pg")}`,
            "vscode-jsonrpc": `link:${join(workspace, "packages", "language-server", "node_modules", "vscode-jsonrpc")}`,
            "vscode-languageserver": `link:${join(workspace, "packages", "language-server", "node_modules", "vscode-languageserver")}`,
            "vscode-languageserver-textdocument": `link:${join(workspace, "packages", "language-server", "node_modules", "vscode-languageserver-textdocument")}`,
          };
      await write(
        join(consumer, "package.json"),
        `${JSON.stringify(
          {
            private: true,
            type: "module",
            dependencies: { ...dependencies, ...driverLinks },
            ...(registryOnly
              ? {}
              : {
                  pnpm: {
                    overrides: {
                      ...dependencies,
                      ...driverLinks,
                      "@typed-sql/typescript-preview": localTypescript!.preview.package,
                      [`${typescriptPlatformPackage}@${localTypescript!.stable.version}`]:
                        localTypescript!.stable.platformPackage,
                      [`${typescriptPlatformPackage}@${localTypescript!.preview.version}`]:
                        localTypescript!.preview.platformPackage,
                    },
                  },
                }),
          },
          null,
          2,
        )}\n`,
      );
      const installArgs = [
        "install",
        ...(registryOnly ? [] : ["--offline", "--ignore-scripts"]),
        "--no-frozen-lockfile",
      ];
      if (registryOnly) await mustEventuallyRun("pnpm", installArgs, consumer);
      else
        await execFile("pnpm", installArgs, {
          cwd: consumer,
          env: { ...cleanEnvironment, CI: "true" },
        });

      if (registryOnly) {
        const manifest = await readFile(join(consumer, "package.json"), "utf8");
        const lockfile = await readFile(join(consumer, "pnpm-lock.yaml"), "utf8");
        const installedRoot = await realpath(consumer);
        const repositoryRoot = await realpath(workspace);
        for (const forbidden of ["workspace:", "link:", "file:", workspace]) {
          strict.ok(!manifest.includes(forbidden), `registry manifest contains ${forbidden}`);
        }
        for (const protocol of ["workspace:", "link:", "file:"])
          strict.ok(
            !new RegExp(`(?:^|\\s)${protocol}`, "mu").test(lockfile),
            `registry lockfile contains ${protocol} protocol`,
          );
        strict.ok(!lockfile.includes(workspace), "registry lockfile contains the repository path");
        for (const directory of packageNames) {
          const installed = await realpath(join(consumer, "node_modules", "@typed-sql", directory));
          strict.ok(
            installed.startsWith(`${installedRoot}/`),
            `${directory} resolved outside disposable consumer: ${installed}`,
          );
          strict.ok(!installed.startsWith(`${repositoryRoot}/`), `${directory} resolved from the repository`);
          const installedManifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8")) as {
            readonly dependencies?: Readonly<Record<string, string>>;
            readonly optionalDependencies?: Readonly<Record<string, string>>;
          };
          for (const field of [installedManifest.dependencies, installedManifest.optionalDependencies]) {
            for (const driver of ["pg", "mysql2", "better-sqlite3", "sqlite3"]) {
              strict.strictEqual(field?.[driver], undefined, `${directory} installed ${driver} implicitly`);
            }
          }
        }
      }

      await ensureImage(postgresImage, join(workspace, "e2e", "postgres"));
      await ensureImage(mysqlImage, join(workspace, "e2e", "mysql"));
      await mustRun(engine, [
        "run",
        "--detach",
        "--name",
        postgresContainer,
        "--publish",
        `127.0.0.1:${postgresPort}:5432`,
        "--env",
        "POSTGRES_DB=typed_sql_e2e",
        "--env",
        "POSTGRES_USER=typed_sql",
        "--env",
        `POSTGRES_PASSWORD=${artifactCredentialSentinel}`,
        postgresImage,
      ]);
      started.push(postgresContainer);
      await mustRun(engine, [
        "run",
        "--detach",
        "--name",
        mysqlContainer,
        "--publish",
        `127.0.0.1:${mysqlPort}:3306`,
        "--env",
        "MYSQL_DATABASE=typed_sql_e2e",
        "--env",
        "MYSQL_USER=typed_sql",
        "--env",
        `MYSQL_PASSWORD=${artifactCredentialSentinel}`,
        "--env",
        "MYSQL_ROOT_PASSWORD=typed_sql_root",
        mysqlImage,
      ]);
      started.push(mysqlContainer);
      await waitForPort(postgresPort, { host: "127.0.0.1", timeout: 90_000 });
      await waitForPort(mysqlPort, { host: "127.0.0.1", timeout: 90_000 });
      await waitForExpectedResult(
        async () =>
          (
            await run(engine, [
              "exec",
              postgresContainer,
              "pg_isready",
              "--username",
              "typed_sql",
              "--dbname",
              "typed_sql_e2e",
            ])
          ).code,
        0,
        { interval: 250, timeout: 90_000, strict: true },
      );
      await waitForExpectedResult(
        async () => {
          const logs = await run(engine, ["logs", mysqlContainer]);
          return `${logs.stdout}${logs.stderr}`.toLowerCase().includes("mysql init process done. ready for start up.");
        },
        true,
        { interval: 250, timeout: 90_000, strict: true },
      );
      await waitForExpectedResult(
        async () =>
          (
            await run(engine, [
              "exec",
              mysqlContainer,
              "mysqladmin",
              "ping",
              "--host=127.0.0.1",
              "--user=typed_sql",
              `--password=${artifactCredentialSentinel}`,
            ])
          ).code,
        0,
        { interval: 250, timeout: 90_000, strict: true },
      );

      for (const name of dialectNames) await mkdir(join(consumer, name, "src"), { recursive: true });
      await write(
        join(consumer, "postgres", "typed-sql.config.ts"),
        `
        import { defineConfig } from "@typed-sql/core";
        import { postgres, typePolicy } from "@typed-sql/postgres";
        import { createPgLiveVerifier, pg } from "@typed-sql/postgres/pg";
        const connectionString = "postgresql://typed_sql:${artifactCredentialSentinel}@127.0.0.1:${postgresPort}/typed_sql_e2e";
        const dialect = postgres({ typePolicy });
        export default defineConfig({
          dialect,
          schema: { file: "generated/schema.json", provider: pg({ connectionString, schemas: ["public"], typePolicy }) },
          outDir: "generated",
          projects: ["tsconfig.json"],
          typePolicy,
          manifest: { outFile: ".typed-sql/queries.json" },
          verification: {
            live: createPgLiveVerifier({ connectionString, typePolicy }),
            proofFile: ".typed-sql/verification.json",
            concurrency: 2,
          },
        });
      `,
      );
      await write(
        join(consumer, "mysql", "typed-sql.config.ts"),
        `
        import { defineConfig } from "@typed-sql/core";
        import { mysql, typePolicy } from "@typed-sql/mysql";
        import { createMySql2LiveVerifier, mysql2 } from "@typed-sql/mysql/mysql2";
        const connectionUri = "mysql://typed_sql:${artifactCredentialSentinel}@127.0.0.1:${mysqlPort}/typed_sql_e2e";
        const dialect = mysql({ typePolicy });
        export default defineConfig({
          dialect,
          schema: { file: "generated/schema.json", provider: mysql2({ connectionUri, schemas: ["typed_sql_e2e"], typePolicy }) },
          outDir: "generated",
          projects: ["tsconfig.json"],
          typePolicy,
          manifest: { outFile: ".typed-sql/queries.json" },
          verification: {
            live: createMySql2LiveVerifier({ connectionUri, typePolicy }),
            proofFile: ".typed-sql/verification.json",
            concurrency: 2,
          },
        });
      `,
      );
      await write(
        join(consumer, "mysql", "typed-sql.verification.config.ts"),
        `
        import { defineConfig } from "@typed-sql/core";
        import config from "./typed-sql.config.js";
        export default defineConfig({
          ...config,
          projects: ["tsconfig.verification.json"],
          manifest: { outFile: ".typed-sql/verification-queries.json" },
          verification: {
            ...config.verification,
            proofFile: ".typed-sql/verification.json",
          },
        });
      `,
      );
      await write(
        join(consumer, "sqlite", "initialize.mjs"),
        `
        import { DatabaseSync } from "node:sqlite";
        import { fileURLToPath } from "node:url";
        const database = new DatabaseSync(fileURLToPath(new URL("./database.sqlite", import.meta.url)));
        try {
          database.exec(\`
            CREATE TABLE account (
              id INTEGER PRIMARY KEY,
              email TEXT NOT NULL,
              balance REAL,
              enabled INTEGER NOT NULL
            ) STRICT;
            INSERT INTO account (id, email, balance, enabled) VALUES
              (1, 'alice@example.com', 12500.5, 1),
              (2, 'bob@example.com', NULL, 0);
          \`);
        } finally {
          database.close();
        }
      `,
      );
      await mustRun(process.execPath, [join(consumer, "sqlite", "initialize.mjs")], join(consumer, "sqlite"));
      await write(
        join(consumer, "sqlite", "typed-sql.config.ts"),
        `
        import { fileURLToPath } from "node:url";
        import { defineConfig } from "@typed-sql/core";
        import { sqlite, typePolicy } from "@typed-sql/sqlite";
        import { nodeSqlite } from "@typed-sql/sqlite/node-sqlite";
        const path = fileURLToPath(new URL("./database.sqlite", import.meta.url));
        const dialect = sqlite({ typePolicy });
        export default defineConfig({
          dialect,
          schema: { file: "generated/schema.json", provider: nodeSqlite({ path, typePolicy }) },
          outDir: "generated",
          projects: ["tsconfig.json"],
          typePolicy,
          manifest: { outFile: ".typed-sql/queries.json" },
        });
      `,
      );
      const tsconfig = JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            module: "nodenext",
            moduleResolution: "nodenext",
            target: "es2024",
            types: ["node"],
            noEmit: true,
          },
          include: ["src", "generated", "typed-sql.config.ts"],
        },
        null,
        2,
      );
      await write(join(consumer, "postgres", "tsconfig.json"), tsconfig);
      await write(join(consumer, "mysql", "tsconfig.json"), tsconfig);
      await write(join(consumer, "sqlite", "tsconfig.json"), tsconfig);
      await write(
        join(consumer, "mysql", "tsconfig.verification.json"),
        JSON.stringify(
          {
            extends: "./tsconfig.json",
            include: ["src/verification-query.ts", "generated", "typed-sql.config.ts"],
          },
          null,
          2,
        ),
      );
      const cli = join(consumer, "node_modules", "@typed-sql", "cli", "dist", "packages", "cli", "src", "cli.js");
      for (const name of dialectNames)
        await mustRun(
          process.execPath,
          [cli, "generate", "--config", join(consumer, name, "typed-sql.config.ts")],
          join(consumer, name),
        );

      await write(
        join(consumer, "postgres", "src", "query.ts"),
        `
        import { sql, typePolicy } from "@typed-sql/postgres";
        import { createPgDatabase } from "@typed-sql/postgres/pg";
        import type { QueryParameters, QueryRow } from "@typed-sql/core";
        import { z } from "zod";
        type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
        type Assert<T extends true> = T;
        export const query = sql\`
          SELECT account.id, account.email, account.status, project.budget::NUMERIC AS budget
          FROM users AS account
          LEFT JOIN projects AS project ON project.owner_id = account.id
          WHERE account.id >= \${1n}
            AND account.email <> \${${JSON.stringify(artifactParameterSentinel)}}
          ORDER BY account.id
        \`;
        const queryParameters: Assert<Equal<QueryParameters<typeof query>, readonly [bigint, string]>> = true;
        void queryParameters;
        const querySchema = z.object({
          id: z.bigint(), email: z.string(), status: z.enum(["active", "suspended"]), budget: z.string().nullable(),
        });
        export const validatedQuery = sql.validateResult(query, querySchema);
        const validatedRow: Assert<Equal<QueryRow<typeof validatedQuery>, z.output<typeof querySchema>>> = true;
        void validatedRow;

        export const cteQuery = sql\`
          WITH project_totals AS (
            SELECT project.owner_id, COUNT(*) AS project_count, SUM(project.budget) AS total_budget
            FROM projects AS project GROUP BY project.owner_id
          )
          SELECT account.id, project_totals.project_count, project_totals.total_budget,
                 active_user_count() AS active_count
          FROM users AS account
          LEFT JOIN project_totals ON project_totals.owner_id = account.id
        \`;
        const cteRow: Assert<Equal<QueryRow<typeof cteQuery>, {
          id: bigint; project_count: bigint | null; total_budget: string | null; active_count: bigint | null;
        }>> = true;
        void cteRow;

        interface AccountSelect { readonly status: boolean }
        interface AccountFilters { readonly status?: "active" | "suspended" | null; readonly minimumId?: bigint | null }
        export function accounts<const Select extends AccountSelect>(select: Select, filters: AccountFilters) {
          return sql\`
            SELECT account.id, account.email
              \${select.status ? sql.fragment\`, account.status\` : sql.empty}
            FROM users AS account
            WHERE 1 = 1
              \${filters.status == null ? sql.empty : sql.fragment\`AND account.status = \${filters.status}\`}
              \${filters.minimumId == null ? sql.empty : sql.fragment\`AND account.id >= \${filters.minimumId}\`}
          \`;
        }
        const withoutStatus = accounts({ status: false }, {});
        const withStatus = accounts({ status: true }, {});
        declare const runtimeStatus: boolean;
        const runtimeProjection = accounts({ status: runtimeStatus }, {});
        const filtered = accounts({ status: true }, { status: "active", minimumId: 1n });
        const falseRow: Assert<Equal<QueryRow<typeof withoutStatus>, { id: bigint; email: string }>> = true;
        const trueRow: Assert<Equal<QueryRow<typeof withStatus>, { id: bigint; email: string; status: "active" | "suspended" }>> = true;
        const runtimeRow: Assert<Equal<QueryRow<typeof runtimeProjection>,
          { id: bigint; email: string; status: "active" | "suspended" } | { id: bigint; email: string }
        >> = true;
        const filterParameters: Assert<Equal<QueryParameters<typeof filtered>,
          readonly [] | readonly ["active" | "suspended"] | readonly [bigint] |
          readonly ["active" | "suspended", bigint]
        >> = true;
        void [falseRow, trueRow, runtimeRow, filterParameters];

        async function verifyInferredRows(): Promise<void> {
          const database = await createPgDatabase({ connectionString: "postgresql://unused-at-typecheck", typePolicy });
          const rows = await database.execute(query);
          const exact: Assert<Equal<(typeof rows)[number], {
            id: bigint; email: string; status: "active" | "suspended"; budget: string | null;
          }>> = true;
          void exact;
          await database.close();
        }
        void verifyInferredRows;
      `,
      );
      await write(
        join(consumer, "mysql", "src", "query.ts"),
        `
        import { sql, typePolicy } from "@typed-sql/mysql";
        import { createMySql2Database } from "@typed-sql/mysql/mysql2";
        import type { QueryParameters, QueryRow } from "@typed-sql/core";
        import * as v from "valibot";
        type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
        type Assert<T extends true> = T;
        export const query = sql\`
          SELECT account.id, account.email, account.status, project.budget
          FROM users AS account
          LEFT JOIN projects AS project ON project.owner_id = account.id
          WHERE account.id >= \${1n}
            AND account.email <> \${${JSON.stringify(artifactParameterSentinel)}}
          ORDER BY account.id
        \`;
        const queryParameters: Assert<Equal<QueryParameters<typeof query>, readonly [bigint, string]>> = true;
        void queryParameters;
        const querySchema = v.object({
          id: v.bigint(), email: v.string(), status: v.picklist(["active", "suspended"]), budget: v.nullable(v.string()),
        });
        export const validatedQuery = sql.validateResult(query, querySchema);
        const validatedRow: Assert<Equal<QueryRow<typeof validatedQuery>, v.InferOutput<typeof querySchema>>> = true;
        void validatedRow;

        export const cteQuery = sql\`
          WITH project_totals AS (
            SELECT project.owner_id, COUNT(*) AS project_count, SUM(project.budget) AS total_budget
            FROM projects AS project GROUP BY project.owner_id
          )
          SELECT account.id, project_totals.project_count, project_totals.total_budget,
                 user_count() AS account_count
          FROM users AS account
          LEFT JOIN project_totals ON project_totals.owner_id = account.id
        \`;
        const cteRow: Assert<Equal<QueryRow<typeof cteQuery>, {
          id: bigint; project_count: bigint | null; total_budget: string | null; account_count: bigint | null;
        }>> = true;
        void cteRow;

        interface AccountSelect { readonly status: boolean }
        interface AccountFilters { readonly status?: "active" | "suspended" | null; readonly minimumId?: bigint | null }
        export function accounts<const Select extends AccountSelect>(select: Select, filters: AccountFilters) {
          return sql\`
            SELECT account.id, account.email
              \${select.status ? sql.fragment\`, account.status\` : sql.empty}
            FROM users AS account
            WHERE 1 = 1
              \${filters.status == null ? sql.empty : sql.fragment\`AND account.status = \${filters.status}\`}
              \${filters.minimumId == null ? sql.empty : sql.fragment\`AND account.id >= \${filters.minimumId}\`}
          \`;
        }
        const withoutStatus = accounts({ status: false }, {});
        const withStatus = accounts({ status: true }, {});
        declare const runtimeStatus: boolean;
        const runtimeProjection = accounts({ status: runtimeStatus }, {});
        const filtered = accounts({ status: true }, { status: "active", minimumId: 1n });
        const falseRow: Assert<Equal<QueryRow<typeof withoutStatus>, { id: bigint; email: string }>> = true;
        const trueRow: Assert<Equal<QueryRow<typeof withStatus>, { id: bigint; email: string; status: "active" | "suspended" }>> = true;
        const runtimeRow: Assert<Equal<QueryRow<typeof runtimeProjection>,
          { id: bigint; email: string; status: "active" | "suspended" } | { id: bigint; email: string }
        >> = true;
        const filterParameters: Assert<Equal<QueryParameters<typeof filtered>,
          readonly [] | readonly ["active" | "suspended"] | readonly [bigint] |
          readonly ["active" | "suspended", bigint]
        >> = true;
        void [falseRow, trueRow, runtimeRow, filterParameters];

        async function verifyInferredRows(): Promise<void> {
          const database = await createMySql2Database({ connectionUri: "mysql://unused-at-typecheck", typePolicy });
          const rows = await database.execute(query);
          const exact: Assert<Equal<(typeof rows)[number], {
            id: bigint; email: string; status: "active" | "suspended"; budget: string | null;
          }>> = true;
          void exact;
          await database.close();
        }
        void verifyInferredRows;
      `,
      );
      await write(
        join(consumer, "sqlite", "src", "query.ts"),
        `
        import { sql, typePolicy } from "@typed-sql/sqlite";
        import { createNodeSqliteDatabase } from "@typed-sql/sqlite/node-sqlite";
        import type { QueryParameters, QueryRow } from "@typed-sql/core";
        type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
        type Assert<T extends true> = T;

        export const query = sql\`
          WITH enabled_accounts AS (
            SELECT account.id, account.email, account.balance
            FROM account
            WHERE account.enabled = \${1n}
          )
          SELECT enabled_accounts.id, enabled_accounts.email, enabled_accounts.balance
          FROM enabled_accounts
          WHERE enabled_accounts.email <> \${${JSON.stringify(artifactParameterSentinel)}}
          ORDER BY enabled_accounts.id
        \`;
        const queryParameters: Assert<Equal<QueryParameters<typeof query>, readonly [bigint, string]>> = true;
        const queryRow: Assert<Equal<QueryRow<typeof query>, {
          id: bigint; email: string; balance: number | null;
        }>> = true;
        void [queryParameters, queryRow];

        export const byId = (id: bigint) => sql\`
          SELECT account.id, account.email, account.balance
          FROM account
          WHERE account.id = \${id}
        \`;
        const byIdParameters: Assert<Equal<QueryParameters<ReturnType<typeof byId>>, readonly [bigint]>> = true;
        void byIdParameters;

        async function verifyInferredRows(): Promise<void> {
          const database = await createNodeSqliteDatabase({ path: new URL("../database.sqlite", import.meta.url), typePolicy });
          const rows = await database.execute(query);
          const exact: Assert<Equal<(typeof rows)[number], {
            id: bigint; email: string; balance: number | null;
          }>> = true;
          void exact;
          await database.close();
        }
        void verifyInferredRows;
      `,
      );
      await write(
        join(consumer, "mysql", "src", "verification-query.ts"),
        `
        import { sql } from "@typed-sql/mysql";
        export const verifiedAccount = sql\`
          SELECT account.id, account.email
          FROM users AS account
          WHERE account.id = \${1n}
            AND account.email <> \${${JSON.stringify(artifactParameterSentinel)}}
        \`;
      `,
      );
      await write(
        join(consumer, "postgres", "src", "server.ts"),
        `
        import { createServer, type Server } from "node:http";
        import { sql, typePolicy } from "@typed-sql/postgres";
        import { createPgDatabase } from "@typed-sql/postgres/pg";

        export const dashboardQuery = sql\`
          WITH project_totals AS (
            SELECT projects.owner_id, SUM(projects.budget) AS total_budget
            FROM projects GROUP BY projects.owner_id
          )
          SELECT users.id, users.email, project_totals.total_budget,
                 active_user_count() AS active_count
          FROM users
          LEFT JOIN project_totals ON project_totals.owner_id = users.id
          WHERE users.id >= \${1n}
          ORDER BY users.id
        \`;

        export async function loadDashboard() {
          const database = await createPgDatabase({
            connectionString: "postgresql://typed_sql:${artifactCredentialSentinel}@127.0.0.1:${postgresPort}/typed_sql_e2e",
            typePolicy,
          });
          try {
            const rows = await database.execute(dashboardQuery);
            type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
            const exact: Equal<(typeof rows)[number], {
              id: bigint; email: string; total_budget: string | null; active_count: bigint | null;
            }> = true;
            void exact;
            return rows;
          } finally { await database.close(); }
        }

        export type DashboardResponse = { readonly data: Awaited<ReturnType<typeof loadDashboard>> };
        const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
        export function createDashboardServer(): Server {
          return createServer(async (request, response) => {
            if (request.method !== "GET" || request.url !== "/dashboard") {
              response.writeHead(404, { "content-type": "application/json" });
              response.end(json({ error: "not_found" }));
              return;
            }
            const payload: DashboardResponse = { data: await loadDashboard() };
            response.writeHead(200, { "content-type": "application/json" });
            response.end(json(payload));
          });
        }
      `,
      );
      for (const name of dialectNames)
        await mustRun(
          process.execPath,
          [
            cli,
            "check",
            "--config",
            join(consumer, name, "typed-sql.config.ts"),
            "--file",
            join(consumer, name, "src", "query.ts"),
            "--project",
            join(consumer, name, "tsconfig.json"),
          ],
          join(consumer, name),
        );
      await mustRun(
        process.execPath,
        [
          cli,
          "check",
          "--config",
          join(consumer, "postgres", "typed-sql.config.ts"),
          "--file",
          join(consumer, "postgres", "src", "server.ts"),
          "--project",
          join(consumer, "postgres", "tsconfig.json"),
        ],
        join(consumer, "postgres"),
      );

      for (const name of dialectNames) {
        const directory = join(consumer, name);
        const manifestPath = join(directory, ".typed-sql", "queries.json");
        const manifest = await mustRun(
          process.execPath,
          [cli, "manifest", "--config", join(directory, "typed-sql.config.ts")],
          directory,
        );
        strict.match(manifest.stdout, /Generated \d+ queries \(0 unresolved/u);
        const firstManifest = await assertPortableArtifact(manifestPath, consumer);
        await mustRun(
          process.execPath,
          [cli, "manifest", "--config", join(directory, "typed-sql.config.ts")],
          directory,
        );
        strict.strictEqual(
          await readFile(manifestPath, "utf8"),
          firstManifest,
          `${name} manifest is not deterministic`,
        );
      }
      for (const name of ["postgres", "mysql"] as const) {
        const directory = join(consumer, name);
        const config = join(directory, name === "mysql" ? "typed-sql.verification.config.ts" : "typed-sql.config.ts");
        if (name === "mysql") {
          // COM_STMT_PREPARE exposes ENUM selections as generic strings, so live verification uses a
          // separate exact-native corpus while the application manifest still retains enum inference.
          await mustRun(process.execPath, [cli, "manifest", "--config", config], directory);
          await assertPortableArtifact(join(directory, ".typed-sql", "verification-queries.json"), consumer);
        }
        const live = await mustRun(process.execPath, [cli, "verify", "--live", "--config", config], directory);
        strict.match(live.stdout, /Verified \d+ variants \(0 mismatched, 0 skipped, 0 failed/u);
        const cached = await mustRun(process.execPath, [cli, "verify", "--config", config], directory);
        strict.match(cached.stdout, /Cached verification is current/u);
        await assertPortableArtifact(join(directory, ".typed-sql", "verification.json"), consumer);
      }

      const languageServer = join(consumer, "node_modules", ".bin", "typed-sql-language-server");
      for (const name of dialectNames) {
        const directory = join(consumer, name);
        const queryFile = join(directory, "src", "query.ts");
        const source = await readFile(queryFile, "utf8");
        const uri = pathToFileURL(queryFile).href;
        const client = new ProtocolClient(languageServer, ["--stdio"], directory, cleanEnvironment);
        try {
          await client.request("initialize", {
            processId: process.pid,
            rootUri: pathToFileURL(directory).href,
            workspaceFolders: [{ uri: pathToFileURL(directory).href, name }],
            capabilities: {},
          });
          client.notify("initialized", {});
          client.notify("textDocument/didOpen", {
            textDocument: { uri, languageId: "typescript", version: 1, text: source },
          });
          const hover = JSON.stringify(
            await client.request("textDocument/hover", {
              textDocument: { uri },
              position: positionAt(source, source.indexOf("query")),
            }),
          );
          strict.ok(hover.includes("id: bigint"), hover);
          strict.ok(!hover.includes("unknown"), hover);
        } finally {
          await client.close();
        }
      }

      await write(
        join(consumer, "inspect-preview.ts"),
        `
        import { readFile } from "node:fs/promises";
        import { join } from "node:path";
        import { mysql } from "@typed-sql/mysql";
        import { postgres } from "@typed-sql/postgres";
        import { sqlite } from "@typed-sql/sqlite";
        import { analyzeSource } from "@typed-sql/ts-bridge";
        import { NativePreviewTypeScriptBridge } from "@typed-sql/ts-bridge/native-preview";
        const cases = [
          { name: "postgres", dialect: postgres(), expected: ["id: bigint", "email: string"] },
          { name: "mysql", dialect: mysql(), expected: ["id: bigint", 'status: "active" | "suspended"'] },
          { name: "sqlite", dialect: sqlite(), expected: ["id: bigint", "balance: number | null"] },
        ] as const;
        const bridge = NativePreviewTypeScriptBridge.spawn({ cwd: ${JSON.stringify(consumer)} });
        try {
          for (const item of cases) {
            const directory = join(${JSON.stringify(consumer)}, item.name);
            const fileName = join(directory, "src", "query.ts");
            const source = await readFile(fileName, "utf8");
            const schema = item.dialect.validateSnapshot(JSON.parse(await readFile(join(directory, "generated", "schema.json"), "utf8")) as never);
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
      `,
      );
      await mustRun(process.execPath, ["--import", "tsx", join(consumer, "inspect-preview.ts")], consumer);

      await write(
        join(consumer, "verify.ts"),
        `
        import type { AddressInfo } from "node:net";
        import { sql as postgresSql, typePolicy as postgresTypePolicy } from "@typed-sql/postgres";
        import { createPgDatabase } from "@typed-sql/postgres/pg";
        import { sql as mysqlSql, typePolicy as mysqlTypePolicy } from "@typed-sql/mysql";
        import { createMySql2Database } from "@typed-sql/mysql/mysql2";
        import { sql as sqliteSql, typePolicy as sqliteTypePolicy } from "@typed-sql/sqlite";
        import { createNodeSqliteDatabase } from "@typed-sql/sqlite/node-sqlite";
        import { createDashboardServer } from "./postgres/src/server.js";
        import { z } from "zod";
        import * as v from "valibot";
        const postgres = await createPgDatabase({ connectionString: "postgresql://typed_sql:${artifactCredentialSentinel}@127.0.0.1:${postgresPort}/typed_sql_e2e", typePolicy: postgresTypePolicy });
        const mysql = await createMySql2Database({ connectionUri: "mysql://typed_sql:${artifactCredentialSentinel}@127.0.0.1:${mysqlPort}/typed_sql_e2e", typePolicy: mysqlTypePolicy });
        try {
          const pgRows = await postgres.execute(postgresSql.validateResult(
            postgresSql<{ id: bigint; email: string }>\`SELECT id, email FROM users ORDER BY id\`,
            z.object({ id: z.bigint(), email: z.string() }),
          ));
          const myRows = await mysql.execute(mysqlSql.validateResult(
            mysqlSql<{ id: bigint; status: "active" | "suspended" }>\`SELECT id, status FROM users ORDER BY id\`,
            v.object({ id: v.bigint(), status: v.picklist(["active", "suspended"]) }),
          ));
          if (pgRows[0]?.id !== 1n || pgRows[0]?.email !== "alice@example.com") throw new Error("packed pg execution failed");
          if (myRows[0]?.id !== 1n || myRows[0]?.status !== "active") throw new Error("packed mysql2 execution failed");
        } finally { await postgres.close(); await mysql.close(); }

        const sqlite = await createNodeSqliteDatabase({
          path: new URL("./sqlite/database.sqlite", import.meta.url),
          typePolicy: sqliteTypePolicy,
        });
        try {
          type SqliteAccount = { id: bigint; email: string; balance: number | null };
          const allAccounts = sqliteSql<SqliteAccount>\`
            SELECT id, email, balance FROM account ORDER BY id
          \`;
          const byId = sqlite.prepare("packed-account-by-id", (id: bigint) => sqliteSql<SqliteAccount>\`
            SELECT id, email, balance FROM account WHERE id = \${id}
          \`);
          const first = await sqlite.one(byId(1n));
          if (first.email !== "alice@example.com") throw new Error("packed SQLite prepared execution failed");

          const [secondRows, allRows] = await sqlite.batch([byId(2n), allAccounts]);
          if (secondRows[0]?.email !== "bob@example.com" || allRows.length !== 2) {
            throw new Error("packed SQLite batch execution failed");
          }

          const streamed: bigint[] = [];
          for await (const row of sqlite.stream(allAccounts, { batchSize: 1 })) streamed.push(row.id);
          if (streamed.length !== 2 || streamed[0] !== 1n || streamed[1] !== 2n) {
            throw new Error("packed SQLite stream execution failed");
          }
        } finally { await sqlite.close(); }

        const server = createDashboardServer();
        try {
          await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
          });
          const address = server.address() as AddressInfo;
          const response = await fetch(\`http://127.0.0.1:\${address.port}/dashboard\`);
          if (response.status !== 200) throw new Error(\`fake server returned \${response.status}\`);
          const payload = await response.json();
          const expected = { data: [
            { id: "1", email: "alice@example.com", total_budget: "12500.50", active_count: "1" },
            { id: "2", email: "bob@example.com", total_budget: null, active_count: "1" },
          ] };
          if (JSON.stringify(payload) !== JSON.stringify(expected)) {
            throw new Error(\`fake server response mismatch: \${JSON.stringify(payload)}\`);
          }
        } finally {
          await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined)));
        }
      `,
      );
      await mustRun(process.execPath, ["--import", "tsx", join(consumer, "verify.ts")], consumer);
      for (const name of dialectNames) {
        const drift = await mustRun(
          process.execPath,
          [cli, "drift", "--config", join(consumer, name, "typed-sql.config.ts")],
          join(consumer, name),
        );
        strict.ok(drift.stdout.includes("No schema drift detected"));
      }
    } finally {
      for (const container of started.reverse()) await run(engine, ["rm", "--force", container]);
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
