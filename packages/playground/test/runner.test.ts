import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "@typed-sql/config";
import { describe, it, strict } from "poku";
import { contentHash, WorkspaceFiles } from "../src/files.js";
import { callableExports, RunManager } from "../src/runner.js";
import { fixture } from "./helpers/fixture.js";

async function settled(manager: RunManager, id: string) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const record = manager.records.get(id)!;
    if (!["checking", "running", "cancelling"].includes(record.status) && record.finishedAt) return record;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Run did not settle");
}
const limits = { timeoutMs: 8000, maxRows: 5, maxResultBytes: 100_000, maxConsoleBytes: 100_000 };
await describe("captured project execution", async () => {
  await it("discovers only zero-argument callable exports without executing module code", async () => {
    strict.deepEqual(
      await callableExports(
        `throw new Error('discovery must not run');\nexport async function run(){return 1;}\nexport function needsArgument(id:number){return id;}\nexport const arrow=()=>42;`,
      ),
      ["arrow", "run"],
    );
  });
  await it("runs checked named exports and full files in fresh processes, preserving typed metadata and NULL", async () =>
    fixture(async (directory) => {
      await writeFile(
        join(directory, "playground/db.ts"),
        "import {databaseForRun} from '@typed-sql/playground/runtime'; export const db=databaseForRun();\n",
      );
      const source =
        "import {sql} from '@typed-sql/postgres';\nimport {db} from './db.js';\nexport async function run(){return db.all(sql`select id, name from public.accounts where id = ${42}`);}\n";
      await writeFile(join(directory, "playground/query.ts"), source);
      const loaded = await loadConfig({ file: join(directory, "typed-sql.config.mjs") });
      const manager = new RunManager(
        loaded,
        new WorkspaceFiles(directory, ["playground"], ["playground"]),
        limits,
        "local",
        join(directory, "tsconfig.json"),
      );
      manager.trusted = true;
      try {
        const run = manager.start({
          requestId: "named-export-first",
          file: "playground/query.ts",
          revision: contentHash(source),
          mode: "export",
        });
        strict.equal(
          manager.start({
            requestId: "named-export-first",
            file: "playground/query.ts",
            revision: contentHash(source),
            mode: "export",
          }).id,
          run.id,
        );
        const result = await settled(manager, run.id);
        strict.equal(result.status, "succeeded", JSON.stringify(result));
        strict.equal(result.results[0]?.provenance, "unverified");
        strict.match(JSON.stringify(result.results[0]?.value), /42/);
        strict.match(JSON.stringify(result.results[0]?.value), /null/);
        const second = manager.start({
          requestId: "named-export-second",
          file: "playground/query.ts",
          revision: contentHash(source),
          mode: "export",
        });
        strict.equal((await settled(manager, second.id)).status, "succeeded");
        const full =
          "import {show} from '@typed-sql/playground/runtime';\nconsole.log('full file executed');show('fixture',[{id:9007199254740993n}]);\n";
        await writeFile(join(directory, "playground/full.ts"), full);
        const fullRun = manager.start({
          requestId: "full-file-request",
          file: "playground/full.ts",
          revision: contentHash(full),
          mode: "file",
        });
        const fullResult = await settled(manager, fullRun.id);
        strict.equal(fullResult.status, "succeeded", JSON.stringify(fullResult));
        strict.match(fullResult.logs, /full file executed/);
        strict.equal(fullResult.results[0]?.name, "fixture");
      } finally {
        await manager.close();
      }
    }));
  await it("blocks semantic errors, stale source and unknown dynamic dependency graphs before execution", async () =>
    fixture(async (directory) => {
      const source = "export async function run(){const invalid:number='wrong';return invalid;}\n";
      await writeFile(join(directory, "playground/error.ts"), source);
      const manager = new RunManager(
        await loadConfig({ file: join(directory, "typed-sql.config.mjs") }),
        new WorkspaceFiles(directory, ["playground"], ["playground"]),
        limits,
        "local",
        join(directory, "tsconfig.json"),
      );
      manager.trusted = true;
      try {
        const stale = manager.start({
          requestId: "stale-source-request",
          file: "playground/error.ts",
          revision: "old",
          mode: "export",
        });
        strict.equal((await settled(manager, stale.id)).error?.code, "STALE_SOURCE");
        const invalid = manager.start({
          requestId: "type-error-request",
          file: "playground/error.ts",
          revision: contentHash(source),
          mode: "export",
        });
        const failed = await settled(manager, invalid.id);
        strict.equal(failed.status, "failed");
        strict.equal(failed.error?.code, "TYPECHECK");
        strict.match(failed.error?.message ?? "", /TS2322/);
        const dynamic = "export async function run(){return import('./dependency.js');}\n";
        await writeFile(join(directory, "playground/error.ts"), dynamic);
        await writeFile(join(directory, "playground/dependency.ts"), "export const value=1;");
        const dynamicRun = manager.start({
          requestId: "dynamic-import-request",
          file: "playground/error.ts",
          revision: contentHash(dynamic),
          mode: "export",
        });
        const dynamicResult = await settled(manager, dynamicRun.id);
        strict.equal(dynamicResult.status, "failed");
        strict.match(JSON.stringify(dynamicResult), /Dynamic project imports|MODULE_GRAPH|checking\/build/);
      } finally {
        await manager.close();
      }
    }));
  await it("executes SQL with separately bound scalar values and rejects invalid types", async () =>
    fixture(async (directory) => {
      const source = "select id from public.accounts where id=$1";
      await writeFile(join(directory, "playground/query.sql"), source);
      const manager = new RunManager(
        await loadConfig({ file: join(directory, "typed-sql.config.mjs") }),
        new WorkspaceFiles(directory, ["playground"], ["playground"]),
        limits,
        "local",
        join(directory, "tsconfig.json"),
      );
      try {
        const run = manager.start({
          requestId: "bound-sql-request",
          file: "playground/query.sql",
          revision: contentHash(source),
          mode: "sql",
          values: [13],
        });
        const result = await settled(manager, run.id);
        strict.equal(result.status, "succeeded", JSON.stringify(result));
        strict.equal(result.results[0]?.provenance, "managed");
        strict.match(JSON.stringify(result.results[0]?.value), /13/);
        const invalid = manager.start({
          requestId: "bound-sql-invalid",
          file: "playground/query.sql",
          revision: contentHash(source),
          mode: "sql",
          values: ["wrong"],
        });
        strict.equal((await settled(manager, invalid.id)).error?.code, "BINDINGS");
      } finally {
        await manager.close();
      }
    }));
});

await describe("SQL imports and bounded worker lifetime", async () => {
  await it("executes imported SQL with generated declarations and blocks stale declaration evidence", async () =>
    fixture(async (directory) => {
      const sql = "select id, name from public.accounts where id=:accountId";
      await writeFile(join(directory, "playground/accounts.sql"), sql);
      const source =
        "import account from './accounts.sql';\nimport {databaseForRun} from '@typed-sql/playground/runtime';\nexport async function run(){return databaseForRun().all(account({accountId:42}));}\n";
      await writeFile(join(directory, "playground/imported.ts"), source);
      const loaded = await loadConfig({ file: join(directory, "typed-sql.config.mjs") });
      const manager = new RunManager(
        loaded,
        new WorkspaceFiles(directory, ["playground"], ["playground"]),
        limits,
        "local",
        join(directory, "tsconfig.json"),
      );
      manager.trusted = true;
      try {
        const missing = manager.start({
          requestId: "missing-sql-declaration",
          file: "playground/imported.ts",
          revision: contentHash(source),
          mode: "export",
        });
        strict.equal((await settled(manager, missing.id)).error?.code, "SQL_DECLARATION");
        const { compileSqlFile } = await import("@typed-sql/compiler");
        const schema = loaded.config.dialect.validateSnapshot(
          JSON.parse(await (await import("node:fs/promises")).readFile(join(directory, "schema.json"), "utf8")),
        );
        const declaration = compileSqlFile({ source: sql, dialect: loaded.config.dialect, schema });
        await writeFile(join(directory, "playground/accounts.d.sql.ts"), declaration.text);
        const run = manager.start({
          requestId: "imported-sql-execution",
          file: "playground/imported.ts",
          revision: contentHash(source),
          mode: "export",
        });
        const result = await settled(manager, run.id);
        strict.equal(result.status, "succeeded", JSON.stringify(result));
        strict.match(JSON.stringify(result.results), /42/);
        await writeFile(
          join(directory, "playground/accounts.sql"),
          "select id from public.accounts where id=:accountId",
        );
        const stale = manager.start({
          requestId: "stale-sql-declaration",
          file: "playground/imported.ts",
          revision: contentHash(source),
          mode: "export",
        });
        strict.equal((await settled(manager, stale.id)).error?.code, "SQL_DECLARATION_STALE");
      } finally {
        await manager.close();
      }
    }));
  await it("terminates runaway trusted code and keeps cancellation outcome honest", async () =>
    fixture(async (directory) => {
      const source = "export async function run(){while(true){} return [];}";
      await writeFile(join(directory, "playground/runaway.ts"), source);
      const manager = new RunManager(
        await loadConfig({ file: join(directory, "typed-sql.config.mjs") }),
        new WorkspaceFiles(directory, ["playground"], ["playground"]),
        { ...limits, timeoutMs: 3000 },
        "local",
        join(directory, "tsconfig.json"),
      );
      manager.trusted = true;
      try {
        const run = manager.start({
          requestId: "runaway-trusted-source",
          file: "playground/runaway.ts",
          revision: contentHash(source),
          mode: "export",
        });
        const result = await settled(manager, run.id);
        strict.equal(result.status, "outcome-unknown", JSON.stringify(result));
        strict.ok(result.finishedAt);
      } finally {
        await manager.close();
      }
    }));
});
