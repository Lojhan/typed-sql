import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";

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
  "cli",
  "ts-bridge",
  "language-server",
] as const;

await describe("packed public packages", async () => {
  await it("installs every tarball in isolation without a database driver", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-packed-"));
    const tarballs = join(temporary, "tarballs");
    const consumer = join(temporary, "consumer");
    await mkdir(tarballs);
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
        };
        strict.strictEqual(packedManifest.name, packageManifest.name);
        strict.strictEqual(packedManifest.version, packageManifest.version);
        for (const dependency of Object.values(packedManifest.dependencies ?? {})) {
          strict.ok(
            !dependency.startsWith("workspace:"),
            `${packageManifest.name} published an unresolved workspace dependency`,
          );
        }
      }

      await writeFile(
        join(consumer, "package.json"),
        `${JSON.stringify(
          {
            private: true,
            type: "module",
            dependencies,
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
        import { postgres, sql as postgresSql, typePolicy as postgresTypePolicy } from "@typed-sql/postgres";
        import { postgresRenderer } from "@typed-sql/postgres/runtime";
        import { loadPgDriver } from "@typed-sql/postgres/pg";
        import { mysql, sql as mysqlSql, typePolicy as mysqlTypePolicy } from "@typed-sql/mysql";
        import { mysqlRenderer } from "@typed-sql/mysql/runtime";
        import { loadMySql2Driver } from "@typed-sql/mysql/mysql2";
        import { compileSource } from "@typed-sql/compiler";
        import "@typed-sql/ast";
        import "@typed-sql/config";
        import "@typed-sql/schema";
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
        const compiled = compileSource({
          source: 'import { sql } from "@typed-sql/postgres"; const query = sql\`SELECT 1 AS value\`;',
          dialect: postgres(),
          schema: { formatVersion: 1, dialect: "postgres", tables: {} },
        });
        if (compiled.queries.length !== 1 || !compiled.transformedSource.includes("sql<{")) throw new Error("packed package-root inference failed");
        try { await loadPgDriver(); throw new Error("missing pg did not fail"); }
        catch (error) { if (!String(error.message).includes("pnpm add pg")) throw error; }
        try { await loadMySql2Driver(); throw new Error("missing mysql2 did not fail"); }
        catch (error) { if (!String(error.message).includes("pnpm add mysql2")) throw error; }
      `,
      );
      await execFile(process.execPath, [join(consumer, "verify.mjs")], { cwd: consumer, env: isolatedEnvironment });
      strict.ok(true);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
