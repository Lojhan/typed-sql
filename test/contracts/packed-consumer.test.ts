import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";
import { ProtocolClient, positionAt } from "../helpers/protocol-client.js";

const execFile = promisify(execFileCallback);
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { NODE_PATH: _workspaceNodePath, ...isolatedEnvironment } = process.env;
const publicPackages = [
  "ast",
  "core",
  "config",
  "schema",
  "postgres",
  "mysql",
  "compiler",
  "conformance",
  "cli",
  "ts-bridge",
  "language-server",
] as const;
const stableModulePackages = new Set([
  "ast",
  "core",
  "config",
  "schema",
  "postgres",
  "mysql",
  "compiler",
  "conformance",
]);

async function writeEditorProject(
  consumer: string,
  dialect: "mysql" | "postgres",
): Promise<{ readonly directory: string; readonly queryFile: string; readonly source: string }> {
  const directory = join(consumer, `editor-${dialect}`);
  const queryFile = join(directory, "query.ts");
  const sqlModule = `@typed-sql/${dialect}`;
  const source = `
    import { sql } from "${sqlModule}";
    import type { QueryRow } from "@typed-sql/core";

    declare const includeStatus: boolean;
    declare function execute<Query>(query: Query): Promise<readonly QueryRow<Query>[]>;
    const simpleQuery = sql\`SELECT account.id, account.email FROM users AS account\`;
    const rows = await execute(simpleQuery);
    type Actual = (typeof rows)[number];
    const cteQuery = sql\`
      WITH selected_accounts AS (
        SELECT account.id, account.status FROM users AS account
      )
      SELECT selected_accounts.id, selected_accounts.status FROM selected_accounts
    \`;
    const conditionalQuery = sql\`
      SELECT account.id
        \${includeStatus ? sql.fragment\`, account.status\` : sql.empty}
      FROM users AS account
    \`;
    const invalidParameter = sql\`SELECT account.id FROM users AS account WHERE account.id = \${"wrong"}\`;
    void [simpleQuery, rows, cteQuery, conditionalQuery, invalidParameter];
  `;
  await mkdir(directory);
  await writeFile(
    join(directory, "typed-sql.config.ts"),
    `
      import { defineConfig } from "@typed-sql/core";
      import { ${dialect}, typePolicy } from "${sqlModule}";
      const dialect = ${dialect}({ typePolicy });
      export default defineConfig({
        dialect,
        schema: { file: "schema.json" },
        outDir: "generated",
        projects: ["tsconfig.json"],
        typePolicy,
      });
    `,
  );
  await writeFile(
    join(directory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          target: "ES2024",
        },
        include: ["query.ts"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(directory, "schema.json"),
    await readFile(join(workspace, "e2e", dialect, "generated", "db", "schema.json"), "utf8"),
  );
  await writeFile(queryFile, source);
  return { directory, queryFile, source };
}

async function initializeEditor(client: ProtocolClient, directory: string): Promise<void> {
  await client.request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(directory).href,
    workspaceFolders: [{ uri: pathToFileURL(directory).href, name: "packed-consumer" }],
    capabilities: {},
  });
  client.notify("initialized", {});
}

async function hoverText(client: ProtocolClient, queryFile: string, source: string, binding: string): Promise<string> {
  const hover = await client.request("textDocument/hover", {
    textDocument: { uri: pathToFileURL(queryFile).href },
    position: positionAt(source, source.indexOf(binding)),
  });
  return JSON.stringify(hover);
}

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
        if (stableModulePackages.has(directory)) {
          for (const exportTarget of Object.values(packedManifest.exports ?? {})) {
            const declarationTarget = `package/${exportTarget.replace(/^\.\//u, "").replace(/\.js$/u, ".d.ts")}`;
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

          const plugin = Object.freeze({
            contractVersion: DIALECT_CONTRACT_VERSION,
            id: "synthetic",
            grammarVersion: SYNTHETIC_DIALECT_VERSION,
            sqlModule: "@acme/typed-sql-synthetic",
            capabilities,
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
            },
            pnpm: {
              overrides: {
                ...dependencies,
                tsx: `link:${join(workspace, "node_modules", "tsx")}`,
                "@types/node": `link:${join(workspace, "node_modules", "@types", "node")}`,
                "@types/pg": `link:${join(workspace, "node_modules", "@types", "pg")}`,
                "@typed-sql/typescript-preview": `link:${join(workspace, "packages", "ts-bridge", "node_modules", "@typed-sql", "typescript-preview")}`,
                "vscode-jsonrpc": `link:${join(workspace, "packages", "language-server", "node_modules", "vscode-jsonrpc")}`,
                "vscode-languageserver": `link:${join(workspace, "packages", "language-server", "node_modules", "vscode-languageserver")}`,
                "vscode-languageserver-textdocument": `link:${join(workspace, "packages", "language-server", "node_modules", "vscode-languageserver-textdocument")}`,
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      await execFile("pnpm", ["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"], {
        cwd: consumer,
        env: { ...isolatedEnvironment, CI: "true" },
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
        import { compileSource } from "@typed-sql/compiler";
        import { assertGrammarConformance, GRAMMAR_CONFORMANCE_VERSION } from "@typed-sql/conformance";
        import { syntheticConformanceFixture } from "@typed-sql/example-synthetic-grammar/conformance";
        import { parseSchemaSnapshot } from "@typed-sql/schema";
        import "@typed-sql/ast";
        import "@typed-sql/config";
        import "@typed-sql/ts-bridge";
        import "@typed-sql/language-server";

        const require = createRequire(import.meta.url);
        try { require.resolve("pg"); throw new Error("pg was installed transitively"); }
        catch (error) { if (error.message === "pg was installed transitively") throw error; }
        try { require.resolve("mysql2"); throw new Error("mysql2 was installed transitively"); }
        catch (error) { if (error.message === "mysql2 was installed transitively") throw error; }
        if (postgres().id !== "postgres") throw new Error("dialect import failed");
        if (mysql().id !== "mysql") throw new Error("MySQL dialect import failed");
        if (postgres().sqlModule !== "@typed-sql/postgres") throw new Error("PostgreSQL sqlModule contract failed");
        if (mysql().sqlModule !== "@typed-sql/mysql") throw new Error("MySQL sqlModule contract failed");
        if (postgresTypePolicy.bigint !== "bigint" || mysqlTypePolicy.bigint !== "bigint") throw new Error("type policy export failed");
        if (postgresRenderer.placeholder(2) !== "$2") throw new Error("runtime import failed");
        if (mysqlRenderer.placeholder(2) !== "?") throw new Error("MySQL runtime import failed");
        if (postgresSql\`SELECT \${1}\`.segments.length !== 3 || mysqlSql\`SELECT \${1}\`.segments.length !== 3) throw new Error("dialect sql export failed");
        if (typeof compileSource !== "function") throw new Error("compiler import failed");
        if (GRAMMAR_CONFORMANCE_VERSION !== 1) throw new Error("conformance version import failed");
        const conformance = assertGrammarConformance(syntheticConformanceFixture);
        if (conformance.grammar !== "synthetic" || conformance.structuralVariants !== 2) {
          throw new Error("packed third-party grammar conformance failed");
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
          tables: {
            widgets: {
              name: "widgets",
              columns: {
                value: { name: "value", databaseType: "scalar", tsType: "number", nullable: false },
              },
            },
          },
        }));
        const externalCompiled = compileSource({
          source: 'import { sql } from "@acme/typed-sql-synthetic"; const query = sql\`SELECT value FROM widgets WHERE value = \${1}\`;',
          dialect: externalDialect,
          schema: externalSnapshot,
          typePolicy: syntheticTypePolicy,
        });
        if (externalCompiled.diagnostics.length !== 0 || externalCompiled.queries.length !== 1) {
          throw new Error("external grammar could not compile from packed public packages");
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
      `,
      );
      await execFile(process.execPath, [join(consumer, "verify.mjs")], { cwd: consumer, env: isolatedEnvironment });

      const languageServer = join(consumer, "node_modules", ".bin", "typed-sql-language-server");
      for (const dialect of ["postgres", "mysql"] as const) {
        const project = await writeEditorProject(consumer, dialect);
        const uri = pathToFileURL(project.queryFile).href;
        const client = new ProtocolClient(languageServer, ["--stdio"], project.directory, isolatedEnvironment);
        try {
          await initializeEditor(client, project.directory);
          const diagnosticsReady = client.notification(
            "textDocument/publishDiagnostics",
            (params) => (params as { readonly uri?: string }).uri === uri,
          );
          client.notify("textDocument/didOpen", {
            textDocument: { uri, languageId: "typescript", version: 1, text: project.source },
          });
          await diagnosticsReady;
          const diagnostics = (await client.request("textDocument/diagnostic", {
            textDocument: { uri },
          })) as {
            readonly items?: readonly { readonly code?: number | string; readonly message?: string }[];
          };
          strict.ok(
            diagnostics.items?.some((diagnostic) =>
              /not assignable to parameter of type/u.test(diagnostic.message ?? ""),
            ),
            `${dialect} must report the bad interpolation through TypeScript: ${JSON.stringify(diagnostics.items)}`,
          );

          const simple = await hoverText(client, project.queryFile, project.source, "simpleQuery");
          strict.ok(simple.includes("id: bigint"), simple);
          strict.ok(simple.includes("email: string"), simple);
          strict.ok(!simple.includes("unknown"), simple);
          const rows = await hoverText(client, project.queryFile, project.source, "rows");
          strict.ok(rows.includes("readonly"), rows);
          strict.ok(rows.includes("id: bigint"), rows);
          strict.ok(rows.includes("email: string"), rows);
          strict.ok(!rows.includes("unknown"), rows);
          const actual = await hoverText(client, project.queryFile, project.source, "Actual");
          strict.ok(actual.includes("id: bigint"), actual);
          strict.ok(actual.includes("email: string"), actual);
          strict.ok(!actual.includes("unknown"), actual);
          const cte = await hoverText(client, project.queryFile, project.source, "cteQuery");
          strict.ok(cte.includes("id: bigint"), cte);
          strict.ok(cte.includes('status: \\"active\\" | \\"suspended\\"'), cte);
          const conditional = await hoverText(client, project.queryFile, project.source, "conditionalQuery");
          strict.ok(conditional.includes("id: bigint"), conditional);
          strict.ok(conditional.includes("status"), conditional);

          if (dialect === "postgres") {
            const schemaFile = join(project.directory, "schema.json");
            const schema = JSON.parse(await readFile(schemaFile, "utf8")) as {
              tables: { users: { columns: { email: { nullable: boolean } } } };
            };
            schema.tables.users.columns.email.nullable = true;
            await writeFile(schemaFile, `${JSON.stringify(schema, null, 2)}\n`);
            const reloaded = client.notification(
              "textDocument/publishDiagnostics",
              (params) => (params as { readonly uri?: string }).uri === uri,
            );
            client.notify("workspace/didChangeWatchedFiles", {
              changes: [{ uri: pathToFileURL(schemaFile).href, type: 2 }],
            });
            await reloaded;
            const changed = await hoverText(client, project.queryFile, project.source, "simpleQuery");
            const reloadDiagnostics = await client.request("textDocument/diagnostic", {
              textDocument: { uri },
            });
            strict.ok(
              changed.includes("email: string | null"),
              `${changed}\nReload diagnostics: ${JSON.stringify(reloadDiagnostics)}`,
            );
            strict.ok(changed.includes("id: bigint"), changed);

            const reconfigured = client.notification(
              "textDocument/publishDiagnostics",
              (params) => (params as { readonly uri?: string }).uri === uri,
            );
            client.notify("workspace/didChangeConfiguration", { settings: {} });
            await reconfigured;
            const afterConfiguration = await hoverText(client, project.queryFile, project.source, "simpleQuery");
            strict.ok(afterConfiguration.includes("email: string | null"), afterConfiguration);
          }
        } finally {
          await client.close();
        }

        if (dialect === "postgres") {
          const restarted = new ProtocolClient(languageServer, ["--stdio"], project.directory, isolatedEnvironment);
          try {
            await initializeEditor(restarted, project.directory);
            restarted.notify("textDocument/didOpen", {
              textDocument: { uri, languageId: "typescript", version: 1, text: project.source },
            });
            const hover = await hoverText(restarted, project.queryFile, project.source, "simpleQuery");
            strict.ok(hover.includes("email: string | null"), hover);
          } finally {
            await restarted.close();
          }
        }
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
