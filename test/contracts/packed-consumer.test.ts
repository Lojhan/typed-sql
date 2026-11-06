import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";
import { assertFirstUseConsumer } from "../helpers/first-use-consumer.js";
import { assertMinimalGrammarConsumer } from "../helpers/minimal-grammar-consumer.js";
import { packedConsumerOverrides } from "../helpers/packed-editor-consumer.js";
import { assertPackedEditorProject } from "../helpers/packed-editor-project.js";
import { ensurePackedEditorSdk } from "../helpers/packed-editor-sdk.js";
import { assertPortableWorkerConsumer } from "../helpers/portable-worker-consumer.js";
import { assertSqlFileConsumer } from "../helpers/sql-file-consumer.js";

const execFile = promisify(execFileCallback);
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { NODE_PATH: _workspaceNodePath, ...isolatedEnvironment } = process.env;
const publicPackages = [
  "playground",
  "build",
  "adapters",
  "ast",
  "core",
  "opentelemetry",
  "config",
  "schema",
  "postgres",
  "mysql",
  "compiler",
  "conformance",
  "cli",
  "ts-bridge",
  "language-server",
  "sqlite",
  "sqlserver",
  "duckdb",
] as const;
const declarationCheckedPackages = new Set([
  "playground",
  "build",
  "adapters",
  "ast",
  "core",
  "opentelemetry",
  "config",
  "schema",
  "postgres",
  "mysql",
  "compiler",
  "conformance",
  "sqlite",
  "sqlserver",
  "duckdb",
]);

await describe("packed public packages", async () => {
  await it("installs every tarball in isolation without a database driver", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-packed-"));
    const tarballs = join(temporary, "tarballs");
    const grammar = join(temporary, "grammar");
    const consumer = join(temporary, "consumer");
    await mkdir(tarballs);
    await mkdir(grammar);
    await mkdir(consumer);
    try {
      // Contracts also run before the release build on a clean checkout.
      // Pack the same six SDK executables that publication will ship.
      await ensurePackedEditorSdk(workspace);
      const dependencies: Record<string, string> = {};
      for (const directory of publicPackages) {
        const packageManifest = JSON.parse(
          await readFile(join(workspace, "packages", directory, "package.json"), "utf8"),
        ) as {
          readonly name: string;
          readonly version: string;
        };
        const before = new Set(await readdir(tarballs));
        await execFile("pnpm", ["--silent", "--filter", packageManifest.name, "pack", "--pack-destination", tarballs], {
          cwd: workspace,
        });
        const archive = (await readdir(tarballs)).find((entry) => !before.has(entry));
        if (archive === undefined) throw new Error(`pnpm pack did not create an archive for ${packageManifest.name}`);
        dependencies[packageManifest.name] = `file:${join(tarballs, archive)}`;
        const listing = (await execFile("tar", ["-tf", join(tarballs, archive)])).stdout;
        strict.ok(!listing.includes("package/src/"), `${packageManifest.name} published source files`);
        strict.ok(!listing.includes("package/test/"), `${packageManifest.name} published tests`);
        strict.ok(!listing.includes(".tsbuildinfo"), `${packageManifest.name} published build state`);
        for (const document of [
          "package/README.md",
          "package/LICENSE",
          "package/CHANGELOG.md",
          "package/package.json",
        ]) {
          strict.ok(listing.includes(document), `${packageManifest.name} tarball must include ${document}`);
        }
        const packedManifest = JSON.parse(
          (await execFile("tar", ["-xOf", join(tarballs, archive), "package/package.json"])).stdout,
        ) as {
          readonly name: string;
          readonly version: string;
          readonly dependencies?: Readonly<Record<string, string>>;
          readonly exports?: Readonly<Record<string, string>>;
        };
        strict.strictEqual(packedManifest.name, packageManifest.name);
        strict.strictEqual(packedManifest.version, packageManifest.version);
        for (const dependency of Object.values(packedManifest.dependencies ?? {})) {
          strict.ok(
            !dependency.startsWith("workspace:"),
            `${packageManifest.name} published an unresolved workspace dependency`,
          );
        }
        if (declarationCheckedPackages.has(directory)) {
          for (const exportTarget of Object.values(packedManifest.exports ?? {})) {
            const declarationTarget = `package/${exportTarget
              .replace(/^\.\//u, "")
              .replace(/\.cjs$/u, ".d.cts")
              .replace(/\.js$/u, ".d.ts")}`;
            strict.ok(
              listing.includes(declarationTarget),
              `${packageManifest.name} must pack declarations for ${exportTarget}`,
            );
            const declaration = (await execFile("tar", ["-xOf", join(tarballs, archive), declarationTarget])).stdout;
            strict.ok(!declaration.includes("export type *"), `${declarationTarget} contains a wildcard type export`);
          }
        }
      }

      const examplePackage = "@typed-sql/example-synthetic-grammar";
      const beforeExample = new Set(await readdir(tarballs));
      await execFile("pnpm", ["--silent", "--filter", examplePackage, "pack", "--pack-destination", tarballs], {
        cwd: workspace,
      });
      const exampleArchive = (await readdir(tarballs)).find((entry) => !beforeExample.has(entry));
      if (exampleArchive === undefined) throw new Error(`pnpm pack did not create an archive for ${examplePackage}`);
      dependencies[examplePackage] = `file:${join(tarballs, exampleArchive)}`;

      await writeFile(
        join(grammar, "package.json"),
        `${JSON.stringify(
          {
            name: "@acme/typed-sql-synthetic",
            version: "1.0.0",
            type: "module",
            exports: { ".": "./index.mjs" },
            dependencies: {
              "@typed-sql/core": dependencies["@typed-sql/core"],
              "@typed-sql/schema": dependencies["@typed-sql/schema"],
            },
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        join(grammar, "index.mjs"),
        `
          import {
            DIALECT_CONTRACT_VERSION,
            assertDialectPlugin,
            defineDialectCapabilityStates,
            sql,
            unknownQuerySemantics,
          } from "@typed-sql/core";
          import { parseSchemaSnapshot } from "@typed-sql/schema";

          export { sql };
          export const typePolicy = Object.freeze({ scalar: "number" });
          export const SYNTHETIC_DIALECT_VERSION = "1.0.0";

          const capabilities = Object.freeze({ returning: false });
          const range = Object.freeze({ start: 0, end: 1, line: 1, column: 1 });

          function validateSnapshot(value) {
            const snapshot = parseSchemaSnapshot(value);
            if (snapshot.dialect !== "synthetic") {
              throw new TypeError(\`synthetic cannot use a \${snapshot.dialect} schema snapshot\`);
            }
            if (snapshot.dialectVersion !== SYNTHETIC_DIALECT_VERSION) {
              throw new TypeError(
                \`synthetic grammar \${SYNTHETIC_DIALECT_VERSION} cannot use snapshot dialectVersion \${snapshot.dialectVersion}\`,
              );
            }
            return snapshot;
          }

          function resolveCapabilities(snapshot) {
            return defineDialectCapabilityStates({
              returning: {
                level: "unsupported",
                reason: "The synthetic grammar deliberately omits RETURNING.",
                diagnostic: "SYN001",
                evidence: [
                  { kind: "grammar", key: "grammarVersion", value: SYNTHETIC_DIALECT_VERSION },
                  ...(snapshot.server === undefined ? [] : [{
                    kind: "server-version",
                    key: snapshot.server.product,
                    value: snapshot.server.versionKey,
                  }]),
                ],
              },
            }, Object.keys(capabilities));
          }

          const plugin = Object.freeze({
            contractVersion: DIALECT_CONTRACT_VERSION,
            id: "synthetic",
            grammarVersion: SYNTHETIC_DIALECT_VERSION,
            sqlModule: "@acme/typed-sql-synthetic",
            capabilities,
            resolveCapabilities,
            defaultTypePolicy: typePolicy,
            placeholder(index) {
              if (!Number.isInteger(index) || index < 1) throw new RangeError("synthetic parameters start at 1");
              return \`?\${index}\`;
            },
            quoteIdentifier(identifier) {
              return "[" + identifier.replaceAll("]", "]]") + "]";
            },
            analyze(text, _snapshot, policy = typePolicy) {
              if (text === "SELECT value FROM widgets WHERE value = ?1") {
                return {
                  columns: [{ name: "value", tsType: policy.scalar, nullable: false, databaseType: "scalar", range }],
                  parameters: [{ index: 1, tsType: policy.scalar, nullable: false, databaseType: "scalar" }],
                  diagnostics: [],
                  semantics: unknownQuerySemantics({ ...range, end: text.length }, "Synthetic grammar"),
                };
              }
              return {
                columns: [],
                parameters: [],
                diagnostics: [{
                  code: "SYN001",
                  message: "Synthetic grammar does not support this statement",
                  severity: "error",
                  range: { ...range, end: text.length },
                }],
                semantics: unknownQuerySemantics({ ...range, end: text.length }, "Synthetic grammar"),
              };
            },
            validateSnapshot,
          });

          assertDialectPlugin(plugin);
          export function synthetic() {
            return plugin;
          }
        `,
      );

      await writeFile(
        join(consumer, "package.json"),
        `${JSON.stringify(
          {
            private: true,
            type: "module",
            dependencies: {
              ...dependencies,
              "@acme/typed-sql-synthetic": "file:../grammar",
              "@opentelemetry/api": `link:${join(workspace, "node_modules", "@opentelemetry", "api")}`,
              typescript: `link:${join(workspace, "node_modules", "typescript")}`,
            },
            pnpm: {
              overrides: packedConsumerOverrides(workspace, dependencies),
            },
          },
          null,
          2,
        )}\n`,
      );
      // A fresh store catches missing tarball/override closure even on a warm developer machine.
      await execFile(
        "pnpm",
        [
          "install",
          "--offline",
          "--ignore-scripts",
          "--no-frozen-lockfile",
          "--store-dir",
          join(temporary, "pnpm-store"),
        ],
        {
          cwd: consumer,
          env: { ...isolatedEnvironment, CI: "true" },
        },
      );
      await assertFirstUseConsumer({
        directory: join(temporary, "first-use"),
        workspace,
        dependencies,
        env: isolatedEnvironment,
      });
      await writeFile(
        join(consumer, "verify.mjs"),
        `
        import { createRequire } from "node:module";
        import { synthetic, sql as syntheticSql, typePolicy as syntheticTypePolicy } from "@acme/typed-sql-synthetic";
        import { assertDialectPlugin, defineConfig, renderQuery } from "@typed-sql/core";
        import { postgres, sql as postgresSql, typePolicy as postgresTypePolicy } from "@typed-sql/postgres";
        import { postgresRenderer } from "@typed-sql/postgres/runtime";
        import { loadPgDriver } from "@typed-sql/postgres/pg";
        import { mysql, sql as mysqlSql, typePolicy as mysqlTypePolicy } from "@typed-sql/mysql";
        import { mysqlRenderer } from "@typed-sql/mysql/runtime";
        import { loadMySql2Driver } from "@typed-sql/mysql/mysql2";
        import { sqlite, sql as sqliteSql, typePolicy as sqliteTypePolicy } from "@typed-sql/sqlite";
        import { sqliteRenderer } from "@typed-sql/sqlite/runtime";
        import { sqlserver } from "@typed-sql/sqlserver";
        import { loadSqlServerOdbcDriver } from "@typed-sql/sqlserver/odbc";
        import "@typed-sql/sqlserver/runtime";
        import "@typed-sql/sqlserver/msnodesqlv8";
        import "@typed-sql/sqlserver/browser";
        import { duckdb } from "@typed-sql/duckdb";
        import "@typed-sql/duckdb/node-api";
        import "@typed-sql/duckdb/runtime";
        import "@typed-sql/duckdb/browser";
        import { createNodeSqliteDatabase, loadNodeSqlite } from "@typed-sql/sqlite/node-sqlite";
        import { buildQueryManifest, compileSource, parseQueryManifest, serializeQueryManifest } from "@typed-sql/compiler";
        import { assertGrammarConformance, GRAMMAR_CONFORMANCE_VERSION } from "@typed-sql/conformance";
        import { CONFORMANCE_VERSION, runAdaptedGrammarConformanceV1 } from "@typed-sql/conformance/v2";
        import { createOpenTelemetryObserver } from "@typed-sql/opentelemetry";
        import { syntheticConformanceFixture } from "@typed-sql/example-synthetic-grammar/conformance";
        import { parseSchemaSnapshot, serializeSchemaSnapshot, upgradeSchemaSnapshotV1 } from "@typed-sql/schema";
        import "@typed-sql/ast";
        import "@typed-sql/config";
        import "@typed-sql/ts-bridge";
        import "@typed-sql/language-server";

        const require = createRequire(import.meta.url);
        for (const driver of ["pg", "mysql2", "@libsql/client", "@neondatabase/serverless", "postgres", "mssql", "tedious", "koffi", "msnodesqlv8", "@duckdb/node-api", "@duckdb/node-bindings"]) {
          try { require.resolve(driver); throw new Error(driver + " was installed transitively"); }
          catch (error) { if (error.message === driver + " was installed transitively") throw error; }
        }
        if (postgres().id !== "postgres") throw new Error("dialect import failed");
        if (mysql().id !== "mysql") throw new Error("MySQL dialect import failed");
        if (sqlserver().id !== "sqlserver" || sqlserver().sqlModule !== "@typed-sql/sqlserver") throw new Error("SQL Server public grammar contract failed");
        if (duckdb().id !== "duckdb" || duckdb().sqlModule !== "@typed-sql/duckdb") throw new Error("DuckDB public grammar contract failed");
        if (sqlite().id !== "sqlite") throw new Error("SQLite dialect import failed");
        if (sqlserver().id !== "sqlserver" || sqlserver().sqlModule !== "@typed-sql/sqlserver") throw new Error("SQL Server public grammar contract failed");
        if (sqlserver().id !== "sqlserver" || duckdb().id !== "duckdb") throw new Error("native grammar import failed");
        try { await loadSqlServerOdbcDriver(); throw new Error("Koffi was installed transitively"); }
        catch (error) { if (!/koffi/i.test(String(error.message)) || error.message === "Koffi was installed transitively") throw error; }
        if (postgres().sqlModule !== "@typed-sql/postgres") throw new Error("PostgreSQL sqlModule contract failed");
        if (mysql().sqlModule !== "@typed-sql/mysql") throw new Error("MySQL sqlModule contract failed");
        if (sqlite().sqlModule !== "@typed-sql/sqlite") throw new Error("SQLite sqlModule contract failed");
        if (postgresTypePolicy.bigint !== "bigint" || mysqlTypePolicy.bigint !== "bigint") throw new Error("type policy export failed");
        if (postgresRenderer.placeholder(2) !== "$2") throw new Error("runtime import failed");
        if (mysqlRenderer.placeholder(2) !== "?") throw new Error("MySQL runtime import failed");
        if (sqliteRenderer.placeholder(2) !== "?") throw new Error("SQLite runtime import failed");
        if (sqliteTypePolicy.integer !== "bigint") throw new Error("SQLite type policy export failed");
        if (postgresSql\`SELECT \${1}\`.segments.length !== 3 || mysqlSql\`SELECT \${1}\`.segments.length !== 3 || sqliteSql\`SELECT \${1}\`.segments.length !== 3) throw new Error("dialect sql export failed");
        if (typeof compileSource !== "function") throw new Error("compiler import failed");
        if (GRAMMAR_CONFORMANCE_VERSION !== 1) throw new Error("conformance version import failed");
        if (CONFORMANCE_VERSION !== 2) throw new Error("conformance v2 import failed");
        if (typeof createOpenTelemetryObserver !== "function") throw new Error("OpenTelemetry integration import failed");
        const conformance = assertGrammarConformance(syntheticConformanceFixture);
        if (conformance.grammar !== "synthetic" || conformance.structuralVariants !== 2) {
          throw new Error("packed third-party grammar conformance failed");
        }
        const conformanceV2 = runAdaptedGrammarConformanceV1(syntheticConformanceFixture);
        if (conformanceV2.length !== 7 || conformanceV2.some(({ status }) => status !== "pass")) {
          throw new Error("packed third-party grammar conformance v2 failed");
        }
        const compiled = compileSource({
          source: 'import { sql } from "@typed-sql/postgres"; const query = sql\`SELECT 1 AS value\`;',
          dialect: postgres(),
          schema: { formatVersion: 1, dialect: "postgres", tables: {} },
        });
        if (compiled.queries.length !== 1 || !compiled.transformedSource.includes("sql<{")) throw new Error("packed package-root inference failed");

        const externalDialect = synthetic();
        assertDialectPlugin(externalDialect);
        defineConfig({ dialect: externalDialect, schema: { file: "schema.json" }, outDir: "generated" });
        const externalSnapshot = externalDialect.validateSnapshot(parseSchemaSnapshot({
          formatVersion: 1,
          dialect: "synthetic",
          dialectVersion: "1.0.0",
          version: "1.0.0",
          server: { product: "synthetic", version: "1.0.0", versionKey: "1", features: [], settings: {} },
          tables: {
            widgets: {
              name: "widgets",
              columns: {
                value: { name: "value", databaseType: "scalar", tsType: "number", nullable: false },
              },
            },
          },
        }));
        const externalCapabilities = externalDialect.resolveCapabilities(externalSnapshot, syntheticTypePolicy);
        if (externalCapabilities.returning.level !== "unsupported" || !externalCapabilities.returning.evidence.some((item) => item.kind === "server-version")) {
          throw new Error("packed third-party versioned capability resolution failed");
        }
        const externalV2 = externalDialect.validateSnapshot(parseSchemaSnapshot(JSON.parse(
          serializeSchemaSnapshot(upgradeSchemaSnapshotV1(externalSnapshot)),
        )));
        if (externalV2.formatVersion !== 2 || externalV2.relations.widgets?.columns.value?.tsType !== "number") {
          throw new Error("packed third-party grammar could not validate schema v2");
        }
        const externalCompiled = compileSource({
          source: 'import { sql } from "@acme/typed-sql-synthetic"; const query = sql\`SELECT value FROM widgets WHERE value = \${1}\`;',
          dialect: externalDialect,
          schema: externalV2,
          typePolicy: syntheticTypePolicy,
        });
        if (externalCompiled.diagnostics.length !== 0 || externalCompiled.queries.length !== 1) {
          throw new Error("external grammar could not compile from packed public packages");
        }
        const externalManifest = buildQueryManifest({
          rootDir: "/portable/checkout",
          sources: [{
            file: "/portable/checkout/query.ts",
            source: 'import { sql } from "@acme/typed-sql-synthetic"; const query = sql\`SELECT value FROM widgets WHERE value = \${1}\`;'
          }],
          dialect: externalDialect,
          schema: externalV2,
          typePolicy: syntheticTypePolicy,
          compilerVersion: "packed-test",
        });
        const serializedManifest = serializeQueryManifest(externalManifest.manifest);
        if (externalManifest.manifest.schemaFormat !== 2 || externalManifest.manifest.queries.length !== 1 || serializedManifest.includes("/portable/checkout")) {
          throw new Error("packed query manifest contract failed");
        }
        if (parseQueryManifest(JSON.parse(serializedManifest)).queries[0]?.status !== "resolved") {
          throw new Error("packed query manifest reader failed");
        }
        if (!externalCompiled.transformedSource.includes('sql<{ "value": number; }, readonly [number]>')) {
          throw new Error("external grammar inference contract failed");
        }
        const rendered = renderQuery(syntheticSql\`SELECT value FROM widgets WHERE value = \${42}\`, externalDialect);
        if (rendered.text !== "SELECT value FROM widgets WHERE value = ?1" || rendered.values[0] !== 42) {
          throw new Error("external grammar runtime contract failed");
        }
        const unsupported = compileSource({
          source: 'import { sql } from "@acme/typed-sql-synthetic"; const query = sql\`UNSUPPORTED\`;',
          dialect: externalDialect,
          schema: externalSnapshot,
        });
        if (unsupported.queries.length !== 0 || !unsupported.diagnostics.some(({ code }) => code === "SYN001")) {
          throw new Error("external grammar did not fail closed for unsupported SQL");
        }
        try { await loadPgDriver(); throw new Error("missing pg did not fail"); }
        catch (error) { if (!String(error.message).includes("pnpm add pg")) throw error; }
        try { await loadMySql2Driver(); throw new Error("missing mysql2 did not fail"); }
        catch (error) { if (!String(error.message).includes("pnpm add mysql2")) throw error; }
        if ((await loadNodeSqlite()).DatabaseSync === undefined) throw new Error("node:sqlite adapter import failed");
        const sqliteDatabase = await createNodeSqliteDatabase({ path: ":memory:" });
        await sqliteDatabase.execute(sqliteSql\`CREATE TABLE account (id INTEGER PRIMARY KEY, email TEXT NOT NULL) STRICT\`);
        await sqliteDatabase.execute(sqliteSql\`INSERT INTO account (id, email) VALUES (\${1n}, \${"packed@example.com"})\`);
        const sqliteRows = await sqliteDatabase.execute(sqliteSql\`SELECT id, email FROM account\`);
        if (sqliteRows[0]?.id !== 1n || sqliteRows[0]?.email !== "packed@example.com") {
          throw new Error("packed node:sqlite execution failed");
        }
        await sqliteDatabase.close();
      `,
      );
      await execFile(process.execPath, [join(consumer, "verify.mjs")], { cwd: consumer, env: isolatedEnvironment });

      const sdk = join(
        consumer,
        "node_modules",
        "@typed-sql/language-server",
        "sdk",
        `${process.platform}-${process.arch}`,
        process.platform === "win32" ? "tsc.exe" : "tsc",
      );
      const sdkVersion = await execFile(sdk, ["--version"], { cwd: consumer, env: isolatedEnvironment });
      strict.strictEqual(sdkVersion.stdout.trim(), "Version 7.1.0-beta");
      await strict.rejects(execFile(sdk, ["--noEmit"], { cwd: consumer, env: isolatedEnvironment }), /requires --lsp/u);
      const preview = await execFile(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import { typescriptPreviewCliPath } from "@typed-sql/ts-bridge/native-lsp"; console.log(typescriptPreviewCliPath());',
        ],
        { cwd: consumer, env: isolatedEnvironment },
      );
      await assertSqlFileConsumer({ consumer, previewCli: preview.stdout.trim(), env: isolatedEnvironment });
      await assertMinimalGrammarConsumer({
        consumer,
        directory: join(temporary, "minimal-consumer"),
        previewCli: preview.stdout.trim(),
        env: isolatedEnvironment,
      });
      await assertPortableWorkerConsumer({
        consumer,
        viteUrl: pathToFileURL(createRequire(join(workspace, "packages/ts-bridge/package.json")).resolve("vite")).href,
        miniflareUrl: pathToFileURL(
          createRequire(join(workspace, "packages/adapters/package.json")).resolve("miniflare"),
        ).href,
      });
      for (const dialect of ["postgres", "mysql", "sqlite"] as const) {
        await assertPackedEditorProject(consumer, dialect, isolatedEnvironment);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
