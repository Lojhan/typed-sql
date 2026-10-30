import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { describe, it, strict } from "poku";
import { buildInline, buildSnapshot, prepareBuildProject } from "../../../test/helpers/build-project.js";
import { BuildError, BuildSession, generateSqlTypes, loadBuildProject } from "../src/index.js";
import { createTransformer } from "../src/jest-transformer.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "typed-sql-build-unit-"));
  try {
    await prepareBuildProject(directory);
    await mkdir(join(directory, "node_modules/@typed-sql"), { recursive: true });
    await symlink(
      join(workspace, "packages/sqlite"),
      join(directory, "node_modules/@typed-sql/sqlite"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await describe("stable build compiler", async () => {
  await it("maps original Unicode positions through executable metadata and reuses only matching inputs", async () =>
    fixture(async (cwd) => {
      const session = new BuildSession({ cwd, cacheSize: 1 });
      const file = join(cwd, "inline.ts");
      const first = await session.transform(buildInline, file);
      strict.ok(first);
      strict.ok(first!.code.includes(".__typed"));
      strict.equal(await session.transform(buildInline, file), first);
      const generated = first!.code.indexOf("${id}") + 2;
      const original = buildInline.indexOf("${id}") + 2;
      const prefix = first!.code.slice(0, generated);
      const position = originalPositionFor(new TraceMap(first!.map), {
        line: prefix.split("\n").length,
        column: prefix.length - prefix.lastIndexOf("\n") - 1,
      });
      const before = buildInline.slice(0, original);
      strict.equal(position.line, before.split("\n").length);
      strict.equal(position.column, before.length - before.lastIndexOf("\n") - 1);
      await writeFile(
        join(cwd, "schema.json"),
        JSON.stringify({
          ...buildSnapshot,
          tables: {
            account: {
              ...buildSnapshot.tables.account,
              columns: {
                ...buildSnapshot.tables.account.columns,
                email: { ...buildSnapshot.tables.account.columns.email, nullable: true },
              },
            },
          },
        }),
      );
      const second = await session.transform(buildInline, file);
      strict.notEqual(second!.cacheKey, first!.cacheKey);
      strict.ok(second!.code.includes('"nullable":true'));
      await writeFile(join(cwd, "policy.mjs"), 'export const integer = "bigint";\n');
      strict.notEqual((await session.transform(buildInline, file))!.cacheKey, second!.cacheKey);
    }));

  await it("returns original SQL diagnostics and does not load config for unrelated source", async () =>
    fixture(async (cwd) => {
      const session = new BuildSession({ cwd });
      await strict.rejects(
        session.transform("SELECT '😀' AS emoji,\n missing FROM account", join(cwd, "invalid.sql")),
        (error: unknown) => {
          strict.ok(error instanceof BuildError);
          strict.equal((error as BuildError).diagnostics[0]!.line, 2);
          strict.equal((error as BuildError).diagnostics[0]!.code, "TSQ101");
          return true;
        },
      );
      strict.equal(
        await new BuildSession({ cwd, config: "missing.mjs" }).transform(
          "export const other = 1;",
          join(cwd, "other.ts"),
        ),
        null,
      );
      strict.equal(session.accepts(await realpath(join(cwd, "query.sql"))), true);
      strict.equal(session.accepts(join(cwd, "query.sql?raw")), false);
      const fileOnly = new BuildSession({ cwd, inline: false, config: "missing.mjs" });
      strict.equal(fileOnly.accepts(join(cwd, "plain.ts")), true);
      strict.equal(await fileOnly.transform("const value: number = 1", join(cwd, "plain.ts")), null);
      strict.equal(session.accepts(join(cwd, "node_modules/other/query.sql")), false);
      strict.throws(() => new BuildSession({ cacheSize: -1 }), /cacheSize/u);
    }));

  await it("generates portable declarations, detects stale input and preserves application-owned files", async () =>
    fixture(async (cwd) => {
      const result = await generateSqlTypes({ cwd });
      strict.equal(result.files.length, 1);
      const file = join(cwd, "query.d.sql.ts");
      strict.match(await readFile(file, "utf8"), /readonly \[number\]/u);
      await generateSqlTypes({ cwd, check: true });
      const windows = (await readFile(file, "utf8")).replaceAll("\n", "\r\n");
      await writeFile(file, windows);
      await writeFile(join(cwd, "query.sql"), "SELECT id, email FROM account WHERE id = ?\r\n");
      await generateSqlTypes({ cwd, check: true });
      await generateSqlTypes({ cwd });
      strict.equal(await readFile(file, "utf8"), windows);
      await writeFile(join(cwd, "query.sql"), "SELECT email FROM account WHERE id = ?");
      await strict.rejects(generateSqlTypes({ cwd, check: true }), /TSQ_BUILD_TYPES_STALE/u);
      await generateSqlTypes({ cwd });
      await writeFile(join(cwd, "query.sql"), "SELECT missing FROM account");
      await strict.rejects(generateSqlTypes({ cwd }), /TSQ101/u);
      await strict.rejects(readFile(file), /ENOENT/u);
      await writeFile(join(cwd, "query.sql"), "SELECT email FROM account");
      await writeFile(file, "// application-owned\n");
      await strict.rejects(generateSqlTypes({ cwd }), /application-owned/u);
      strict.equal(await readFile(file, "utf8"), "// application-owned\n");
    }));

  await it("keeps schema/config identities independent of checkout paths", async () =>
    fixture(async (first) =>
      fixture(async (second) => {
        strict.equal((await loadBuildProject(first)).configIdentity, (await loadBuildProject(second)).configIdentity);
      }),
    ));

  await it("uses the same fresh config in synchronous and asynchronous Jest entrypoints", async () =>
    fixture(async (cwd) => {
      const transformer = await createTransformer({ cwd, inline: false });
      const file = join(cwd, "query.sql");
      const source = await readFile(file, "utf8");
      const caller = { supportsStaticESM: true, instrument: false, configString: "fixture", config: { rootDir: cwd } };
      const key = transformer.getCacheKey(source, file, caller);
      strict.equal(await transformer.getCacheKeyAsync(source, file, caller), key);
      const sync = transformer.process(source, file, caller);
      const async = await transformer.processAsync(source, file, caller);
      strict.equal(sync.code, async.code);
      await writeFile(join(cwd, "policy.mjs"), 'export const integer = "bigint";\n');
      strict.notEqual(transformer.getCacheKey(source, file, caller), key);
    }));
});
