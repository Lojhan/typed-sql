import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, strict } from "poku";
import { DIALECT_CONTRACT_VERSION, defineConfig, unknownQuerySemantics } from "../../core/src/index.js";
import { loadConfig, loadConfigSource, resolveConfigDialect, runConfigFactory } from "../src/index.js";

const profile = {
  contractVersion: DIALECT_CONTRACT_VERSION,
  id: "vendor/lazy",
  grammarVersion: "1",
  sqlModule: "vendor/lazy",
  runtimeSqlModule: "vendor/lazy/runtime",
  capabilities: {},
  defaultTypePolicy: { integer: "bigint" },
  placeholder: (index: number) => `$${index}`,
  quoteIdentifier: (name: string) => name,
  validateSnapshot: (value: unknown) =>
    value as { formatVersion: 1; dialect: "vendor/lazy"; tables: Record<string, never> },
};
const owner = {
  ...profile,
  analyze: (sql: string) => ({
    columns: [],
    parameters: [],
    diagnostics: [],
    semantics: unknownQuerySemantics({ start: 0, end: sql.length, line: 1, column: 1 }, "fixture"),
  }),
};
await describe("explicit grammar registration", async () => {
  await it("discards resources when post-construction dependency tracking fails without hiding original failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-factory-discard-"));
    const file = join(directory, "config.mjs");
    try {
      await writeFile(file, "// fixture");
      let imported = (_url: string) => {};
      const raw = await loadConfigSource({
        file,
        importer: async (_file, onImport) => {
          imported = onImport;
          return { default: defineConfig({ dialect: profile, schema: { file: "schema.json" }, outDir: "generated" }) };
        },
      });
      let disposed = 0;
      const construct = () => {
        imported(pathToFileURL(join(directory, "missing.mjs")).href);
        return {
          close() {
            disposed++;
          },
        };
      };
      await strict.rejects(runConfigFactory(raw, construct, { onDiscard: (value) => value.close() }), {
        code: "ENOENT",
      });
      strict.equal(disposed, 1);
      await strict.rejects(runConfigFactory(raw, construct), { code: "ENOENT" });
      await strict.rejects(
        runConfigFactory(raw, construct, {
          onDiscard() {
            throw Error("cleanup failed");
          },
        }),
        AggregateError,
      );
      await strict.rejects(
        runConfigFactory(raw, () => {
          throw Error("construction failed");
        }),
        (error: unknown) => {
          if (!(error instanceof AggregateError)) return false;
          strict.match(String(error.errors[0]), /construction failed/u);
          return true;
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await it("tracks explicit contribution factories even when construction fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-contribution-"));
    const file = join(directory, "config.mjs"),
      helper = join(directory, "adapter.mjs");
    try {
      await writeFile(file, "// fixture");
      await writeFile(helper, "export const revision = 1;");
      let imported = (_url: string) => {};
      const importer = async (_file: string, onImport: (url: string) => void) => {
        imported = onImport;
        return { default: defineConfig({ dialect: profile, schema: { file: "schema.json" }, outDir: "generated" }) };
      };
      const raw = await loadConfigSource({ file, importer });
      strict.equal(await runConfigFactory(raw, () => 42), 42);
      await strict.rejects(
        runConfigFactory(raw, async () => {
          imported(pathToFileURL(helper).href);
          throw Error("adapter failed");
        }),
        /adapter failed/u,
      );
      strict.ok(raw.dependencies?.includes(helper));
      await writeFile(helper, "export const revision = 2;");
      strict.notEqual(await loadConfigSource({ file, importer }), raw);
      strict.equal(await runConfigFactory({ file, directory, config: raw.config }, () => 7), 7);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await it("rejects analysis configurations in legacy hosts before loading an analyzer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-legacy-host-"));
    const file = join(directory, "config.mjs");
    try {
      await writeFile(file, "// importer fixture");
      let calls = 0;
      const config = defineConfig({
        dialect: {
          ...profile,
          loadAnalyzer() {
            calls++;
            return owner;
          },
        },
        schema: { file: "schema.json" },
        outDir: "generated",
        analysis: { mode: "frozen" },
      });
      await strict.rejects(loadConfig({ file, importer: async () => ({ default: config }) }), /analysis-aware host/u);
      strict.equal(calls, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await it("defines native/frozen-only and lazy configurations without constructing an analyzer", () => {
    let calls = 0;
    const config = defineConfig({
      dialect: {
        ...profile,
        loadAnalyzer: () => {
          calls++;
          return owner;
        },
      },
      schema: { file: "schema.json" },
      outDir: "generated",
      analysis: { mode: "frozen" },
    });
    strict.equal(calls, 0);
    strict.ok(Object.isFrozen(config));
    strict.ok(!("analyze" in config.dialect));
    strict.doesNotThrow(() => defineConfig({ dialect: profile, schema: { file: "schema.json" }, outDir: "generated" }));
    strict.throws(
      () =>
        defineConfig({
          dialect: { ...profile, loadAnalyzer: false } as unknown as typeof profile,
          schema: { file: "schema.json" },
          outDir: "generated",
        }),
      /loadAnalyzer/u,
    );
  });
  await it("keeps raw config cold, coalesces explicit owner loading and preserves profile rendering/policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-registration-")),
      file = join(directory, "config.mjs");
    try {
      await writeFile(file, "// app-owned importer\n");
      let calls = 0;
      const config = defineConfig({
        dialect: {
          ...profile,
          loadAnalyzer: async () => {
            calls++;
            return {
              ...owner,
              runtimeSqlModule: "vendor/lazy/legacy",
              defaultTypePolicy: { integer: "number" },
              runtimeValueType(this: { readonly id: string }) {
                return this.id === "vendor/lazy" ? ("string" as const) : ("unknown" as const);
              },
            };
          },
        },
        schema: { file: "schema.json" },
        outDir: "generated",
      });
      const importer = async () => ({ default: config });
      const raw = await loadConfigSource({ file, importer });
      strict.equal(calls, 0);
      strict.equal(raw.config, config);
      strict.equal(await loadConfigSource({ file, importer }), raw);
      const [first, second] = await Promise.all([resolveConfigDialect(raw), loadConfig({ file, importer })]);
      strict.equal(first, second);
      strict.equal(calls, 1);
      strict.equal(first.config.dialect.runtimeSqlModule, profile.runtimeSqlModule);
      strict.deepEqual(first.config.dialect.defaultTypePolicy, profile.defaultTypePolicy);
      strict.equal(first.config.dialect.runtimeValueType?.({ tsType: "string", nullable: false }), "string");
      strict.ok(!("analyze" in raw.config.dialect));
      strict.deepEqual(
        first.config.dialect.analyze("SELECT 1", {
          formatVersion: 1,
          dialect: profile.id,
          tables: {},
        }).diagnostics,
        [],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await it("rejects absent, failed or mismatched owners without poisoning a retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-registration-errors-")),
      file = join(directory, "config.mjs");
    try {
      await writeFile(file, "// importer fixture\n");
      const base = { schema: { file: "schema.json" }, outDir: "generated" };
      const cold = await loadConfigSource({ file, importer: async () => ({ default: { ...base, dialect: profile } }) });
      await strict.rejects(() => resolveConfigDialect(cold), /no offline analyzer/u);
      for (const key of ["id", "grammarVersion", "sqlModule"] as const) {
        const raw = await loadConfigSource({
          file,
          importer: async () => ({
            default: { ...base, dialect: { ...profile, loadAnalyzer: () => ({ ...owner, [key]: "different" }) } },
          }),
        });
        await strict.rejects(() => resolveConfigDialect(raw), /differs/u);
      }
      let failed = true;
      const raw = await loadConfigSource({
        file,
        importer: async () => ({
          default: {
            ...base,
            dialect: {
              ...profile,
              loadAnalyzer: () => {
                if (failed) throw Error("owner unavailable");
                return owner;
              },
            },
          },
        }),
      });
      await strict.rejects(() => resolveConfigDialect(raw), /unavailable/u);
      failed = false;
      strict.equal((await resolveConfigDialect(raw)).config.dialect.id, profile.id);
      await strict.rejects(
        () =>
          loadConfigSource({
            file,
            importer: async () => ({ default: { ...base, dialect: { ...profile, loadAnalyzer: 1 } } }),
          }),
        /default-export/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await it("tracks lazy owner imports so edits reload the configuration graph", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-registration-imports-")),
      file = join(directory, "config.mts"),
      helper = join(directory, "owner.mts");
    try {
      const core = pathToFileURL(new URL("../../core/src/index.ts", import.meta.url).pathname).href;
      const body = `import {unknownQuerySemantics} from ${JSON.stringify(core)}; export function createOwner(profile){return {...profile, analyze(sql){return {columns:[],parameters:[],diagnostics:[],semantics:unknownQuerySemantics({start:0,end:sql.length,line:1,column:1},"first")}}}}`;
      await writeFile(helper, body);
      await writeFile(
        file,
        `import {defineConfig,DIALECT_CONTRACT_VERSION} from ${JSON.stringify(core)}; export default defineConfig({dialect:{contractVersion:DIALECT_CONTRACT_VERSION,id:"vendor/lazy",grammarVersion:"1",sqlModule:"vendor/lazy",capabilities:{},defaultTypePolicy:{},placeholder:i=>"$"+i,quoteIdentifier:i=>i,validateSnapshot:i=>i,async loadAnalyzer(){const {createOwner}=await import("./owner.mts");return createOwner(this)}},schema:{file:"schema.json"},outDir:"generated"});`,
      );
      const raw = await loadConfigSource({ file });
      strict.ok(!raw.dependencies?.includes(await realpath(helper)));
      await resolveConfigDialect(raw);
      strict.ok(raw.dependencies?.includes(await realpath(helper)));
      await writeFile(helper, body.replace('"first"', '"second"'));
      const changed = await loadConfigSource({ file });
      strict.notEqual(changed, raw);
      const resolved = await resolveConfigDialect(changed);
      strict.ok(resolved.dependencies?.includes(await realpath(helper)));
      strict.ok((await readFile(helper, "utf8")).includes("second"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
