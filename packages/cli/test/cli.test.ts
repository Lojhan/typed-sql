import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";
import { buildQueryManifest, serializeQueryManifest } from "../../compiler/src/index.js";
import { postgres } from "../../postgres/src/index.js";

const execFile = promisify(execFileCallback);
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(packageDirectory, "../..");
const cli = join(packageDirectory, "src", "cli.ts");
const tsx = fileURLToPath(import.meta.resolve("tsx"));
const version = (
  JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")) as {
    readonly version: string;
  }
).version;

async function execute(args: readonly string[], cwd: string) {
  return execFile(process.execPath, ["--import", tsx, cli, ...args], { cwd });
}

await describe("typed-sql CLI discovery-free commands", async () => {
  await it("shows help without requiring a project config", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-cli-"));
    try {
      for (const args of [[], ["--help"], ["-h"], ["generate", "--help"]]) {
        const result = await execute(args, temporary);
        strict.match(result.stdout, new RegExp(`typed-sql ${version}`, "u"));
        strict.match(result.stdout, /Usage:\n {2}typed-sql <command> \[options\]/u);
        strict.match(result.stdout, /check[\s\S]*generate[\s\S]*drift/u);
        strict.strictEqual(result.stderr, "");
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  await it("shows the installed package version without requiring a project config", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-cli-"));
    try {
      for (const flag of ["--version", "-v"]) {
        const result = await execute([flag], temporary);
        strict.strictEqual(result.stdout, `${version}\n`);
        strict.strictEqual(result.stderr, "");
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  await it("rejects unknown commands before config discovery", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-cli-"));
    try {
      await strict.rejects(execute(["unknown"], temporary), (error: unknown) => {
        if (!(error instanceof Error && "stderr" in error)) return false;
        strict.match(String(error.stderr), /Unknown command unknown/u);
        strict.ok(!String(error.stderr).includes("typed-sql.config.ts"));
        return true;
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

await describe("typed-sql manifest command", async () => {
  await it("writes deterministic project manifests and reuses unchanged analysis", async () => {
    const temporary = await mkdtemp(join(workspace, ".typed-sql-cli-manifest-"));
    try {
      await mkdir(join(temporary, "src"));
      await writeFile(
        join(temporary, "typed-sql.config.ts"),
        [
          'import { defineConfig } from "@typed-sql/core";',
          'import { postgres, typePolicy } from "@typed-sql/postgres";',
          "export default defineConfig({",
          "  dialect: postgres(),",
          '  schema: { file: "schema.json" },',
          '  outDir: "generated",',
          '  projects: ["tsconfig.json"],',
          '  manifest: { outFile: ".typed-sql/queries.json" },',
          "  typePolicy,",
          "});",
        ].join("\n"),
      );
      await writeFile(
        join(temporary, "schema.json"),
        `${JSON.stringify({
          formatVersion: 1,
          dialect: "postgres",
          tables: {
            users: {
              name: "users",
              columns: {
                id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
              },
            },
          },
        })}\n`,
      );
      await writeFile(
        join(temporary, "tsconfig.json"),
        `${JSON.stringify({
          extends: "../tsconfig.base.json",
          compilerOptions: { composite: false },
          include: ["src/**/*.ts"],
        })}\n`,
      );
      await writeFile(
        join(temporary, "src", "query.ts"),
        'import { sql } from "@typed-sql/postgres"; export const query = sql`SELECT users.id FROM users`;\n',
      );

      const first = await execute(["manifest"], temporary);
      strict.match(first.stdout, /Generated 1 queries \(0 unresolved, 0 files reused\)/u);
      const outFile = join(temporary, ".typed-sql", "queries.json");
      const initial = await readFile(outFile, "utf8");
      const second = await execute(["manifest"], temporary);
      strict.match(second.stdout, /Generated 1 queries \(0 unresolved, 1 files reused\)/u);
      strict.strictEqual(await readFile(outFile, "utf8"), initial);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  await it("writes unresolved entries with exit code 2, distinct from build failures", async () => {
    const temporary = await mkdtemp(join(workspace, ".typed-sql-cli-manifest-"));
    try {
      await mkdir(join(temporary, "src"));
      await writeFile(
        join(temporary, "typed-sql.config.ts"),
        [
          'import { defineConfig } from "@typed-sql/core";',
          'import { postgres } from "@typed-sql/postgres";',
          'export default defineConfig({ dialect: postgres(), schema: { file: "schema.json" }, outDir: "generated", projects: ["tsconfig.json"] });',
        ].join("\n"),
      );
      await writeFile(
        join(temporary, "schema.json"),
        `${JSON.stringify({ formatVersion: 1, dialect: "postgres", tables: {} })}\n`,
      );
      await writeFile(
        join(temporary, "tsconfig.json"),
        `${JSON.stringify({ extends: "../tsconfig.base.json", include: ["src/**/*.ts"] })}\n`,
      );
      await writeFile(
        join(temporary, "src", "query.ts"),
        'import { sql } from "@typed-sql/postgres"; export const query = sql`SELECT missing FROM absent`;\n',
      );
      await strict.rejects(execute(["manifest"], temporary), (error: unknown) => {
        if (!(error instanceof Error && "code" in error && "stdout" in error)) return false;
        strict.strictEqual(error.code, 2);
        strict.match(String(error.stdout), /1 unresolved/u);
        return true;
      });
      const manifest = JSON.parse(await readFile(join(temporary, ".typed-sql", "queries.json"), "utf8")) as {
        readonly queries: readonly { readonly status: string }[];
      };
      strict.strictEqual(manifest.queries[0]?.status, "unresolved");
      await strict.rejects(execute(["manifest", "--project", "missing.json"], temporary), (error: unknown) => {
        if (!(error instanceof Error && "code" in error)) return false;
        strict.strictEqual(error.code, 1);
        return true;
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

await describe("typed-sql capabilities command", async () => {
  await it("reports actionable, secret-free capability evidence from the configured snapshot", async () => {
    const temporary = await mkdtemp(join(workspace, ".typed-sql-cli-capabilities-"));
    try {
      await writeFile(
        join(temporary, "typed-sql.config.ts"),
        [
          'import { defineConfig } from "@typed-sql/core";',
          'import { postgres } from "@typed-sql/postgres";',
          'export default defineConfig({ dialect: postgres(), schema: { file: "schema.json" }, outDir: "generated" });',
        ].join("\n"),
      );
      await writeFile(
        join(temporary, "schema.json"),
        `${JSON.stringify({
          formatVersion: 1,
          dialect: "postgres",
          version: "18.6",
          server: {
            product: "postgres",
            version: "18.6",
            versionKey: "18",
            features: ["plpgsql:1.0"],
            settings: { standardConformingStrings: "on" },
          },
          tables: {},
        })}\n`,
      );
      const result = await execute(["capabilities"], temporary);
      strict.match(result.stdout, /Capabilities for postgres grammar/u);
      strict.match(result.stdout, /returning: exact/u);
      strict.match(result.stdout, /feature: plpgsql:1\.0=present/u);
      strict.ok(!result.stdout.includes("connection"));
      strict.strictEqual(result.stderr, "");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

await describe("typed-sql doctor command", async () => {
  await it("reports exact compiler, grammar, schema, server, bridge, and protocol compatibility without secrets", async () => {
    const temporary = await mkdtemp(join(workspace, ".typed-sql-cli-doctor-"));
    try {
      await writeFile(
        join(temporary, "typed-sql.config.ts"),
        [
          'import { defineConfig } from "@typed-sql/core";',
          'import { postgres } from "@typed-sql/postgres";',
          'export default defineConfig({ dialect: postgres(), schema: { file: "schema.json" }, outDir: "generated" });',
        ].join("\n"),
      );
      await writeFile(
        join(temporary, "schema.json"),
        `${JSON.stringify({
          formatVersion: 1,
          dialect: "postgres",
          version: "18.6",
          server: {
            product: "postgres",
            version: "18.6",
            versionKey: "18",
            features: [],
            settings: { standardConformingStrings: "on" },
          },
          tables: {
            users: {
              name: "users",
              columns: {
                id: {
                  name: "id",
                  databaseType: "bigint",
                  tsType: "bigint",
                  nullable: false,
                  defaultExpression: "recognizable-doctor-secret",
                },
              },
            },
          },
        })}\n`,
      );
      const result = await execute(["doctor", "--json"], temporary);
      const report = JSON.parse(result.stdout) as {
        readonly status: string;
        readonly typescript: { readonly version: string; readonly expected: string; readonly support: string };
        readonly grammar: { readonly id: string; readonly capabilityFingerprint: string };
        readonly schema: { readonly formatVersion: number; readonly hash: string };
        readonly server: { readonly product: string; readonly settingKeys: readonly string[] };
        readonly editor: {
          readonly languageServer: { readonly installed: boolean; readonly releaseTrack: string };
          readonly bridge: { readonly backend: string; readonly typescriptPreviewVersion: string };
          readonly protocol: { readonly normalizedClientVersion: number; readonly compatibility: string };
        };
        readonly errors: readonly string[];
      };
      strict.strictEqual(report.status, "ok");
      strict.strictEqual(report.typescript.version, "7.0.2");
      strict.strictEqual(report.typescript.expected, "7.0.2");
      strict.strictEqual(report.typescript.support, "supported");
      strict.strictEqual(report.grammar.id, "postgres");
      strict.match(report.grammar.capabilityFingerprint, /^sha256:[a-f0-9]{64}$/u);
      strict.strictEqual(report.schema.formatVersion, 1);
      strict.match(report.schema.hash, /^[a-f0-9]{64}$/u);
      strict.strictEqual(report.server.product, "postgres");
      strict.deepStrictEqual(report.server.settingKeys, ["standardConformingStrings"]);
      strict.strictEqual(report.editor.languageServer.installed, true);
      strict.strictEqual(report.editor.languageServer.releaseTrack, "experimental");
      strict.strictEqual(report.editor.bridge.backend, "typescript-7.1-native-preview");
      strict.strictEqual(report.editor.bridge.typescriptPreviewVersion, "7.1.0-dev.20260824.1");
      strict.strictEqual(report.editor.protocol.normalizedClientVersion, 1);
      strict.strictEqual(report.editor.protocol.compatibility, "compatible");
      strict.deepStrictEqual(report.errors, []);
      strict.ok(!result.stdout.includes("recognizable-doctor-secret"));
      strict.ok(!result.stdout.includes(temporary));

      const human = await execute(["doctor"], temporary);
      strict.match(human.stdout, /typed-sql doctor: ok[\s\S]*TypeScript: 7\.0\.2 \(supported/u);
      await strict.rejects(execute(["doctor", "--protocol", "2", "--json"], temporary), (error: unknown) => {
        if (!(error instanceof Error && "code" in error && "stdout" in error)) return false;
        strict.strictEqual(error.code, 1);
        strict.match(String(error.stdout), /"compatibility": "unsupported"/u);
        return true;
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

await describe("typed-sql compat command", async () => {
  await it("writes a secret-free rolling-deployment report and enforces configured severity", async () => {
    const temporary = await mkdtemp(join(workspace, ".typed-sql-cli-compat-"));
    try {
      await writeFile(
        join(temporary, "typed-sql.config.ts"),
        [
          'import { defineConfig } from "@typed-sql/core";',
          'import { postgres } from "@typed-sql/postgres";',
          'export default defineConfig({ dialect: postgres(), schema: { file: "after.json" }, outDir: "generated", compatibility: { reportFile: ".typed-sql/compatibility.json" } });',
        ].join("\n"),
      );
      const before = {
        formatVersion: 1 as const,
        dialect: "postgres" as const,
        tables: {
          users: {
            name: "users",
            columns: {
              id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
              email: {
                name: "email",
                databaseType: "text",
                tsType: "string",
                nullable: false,
                defaultExpression: "'recognizable-secret'",
              },
            },
          },
        },
      };
      const after = {
        formatVersion: 1 as const,
        dialect: "postgres" as const,
        tables: {
          users: {
            name: "users",
            columns: {
              id: { name: "id", databaseType: "numeric", tsType: "string", nullable: false },
            },
          },
        },
      };
      const dialect = postgres();
      const source =
        'import { sql } from "@typed-sql/postgres"; declare const id: bigint; export const query = sql`SELECT users.id, users.email FROM users WHERE users.id = ${id}`;';
      const nextSource =
        'import { sql } from "@typed-sql/postgres"; declare const id: string; export const query = sql`SELECT users.id FROM users WHERE users.id = ${id}`;';
      const createManifest = (schema: typeof before | typeof after, value: string) =>
        buildQueryManifest({
          rootDir: temporary,
          sources: [{ file: join(temporary, "query.ts"), source: value }],
          dialect,
          schema,
          compilerVersion: "test",
        }).manifest;
      await writeFile(join(temporary, "before.json"), `${JSON.stringify(before)}\n`);
      await writeFile(join(temporary, "after.json"), `${JSON.stringify(after)}\n`);
      await writeFile(join(temporary, "before-manifest.json"), serializeQueryManifest(createManifest(before, source)));
      await writeFile(
        join(temporary, "after-manifest.json"),
        serializeQueryManifest(createManifest(after, nextSource)),
      );

      const args = [
        "compat",
        "--before",
        "before.json",
        "--after",
        "after.json",
        "--before-manifest",
        "before-manifest.json",
        "--after-manifest",
        "after-manifest.json",
      ] as const;
      const working = join(temporary, "nested");
      await mkdir(working);
      const allowed = await execute([...args, "--fail-on", "none"], working);
      strict.match(allowed.stdout, /Compatibility: \d+ errors/u);
      strict.match(allowed.stderr, /before-app-after-database/u);
      const report = await readFile(join(temporary, ".typed-sql", "compatibility.json"), "utf8");
      strict.ok(!report.includes("recognizable-secret"));
      strict.ok(!report.includes(temporary));
      await strict.rejects(execute(args, working), (error: unknown) => {
        if (!(error instanceof Error && "code" in error)) return false;
        strict.strictEqual(error.code, 1);
        return true;
      });
      await strict.rejects(execute([...args, "--fail-on", "all"], working), /none, warning, or error/u);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

await describe("typed-sql verify command", async () => {
  await it("writes live proof and validates it later without opening a connection", async () => {
    const temporary = await mkdtemp(join(workspace, ".typed-sql-cli-verify-"));
    try {
      await mkdir(join(temporary, "src"));
      await writeFile(
        join(temporary, "typed-sql.config.ts"),
        [
          'import { defineConfig } from "@typed-sql/core";',
          'import { postgres } from "@typed-sql/postgres";',
          "const live = {",
          '  dialect: "postgres", adapterVersion: "fake-v1",',
          '  async server() { return { version: "18.4" }; },',
          '  async verify() { return { columns: [{ index: 1, databaseType: "bigint", tsType: "bigint" }], parameters: [] }; },',
          "  async close() {},",
          "};",
          "export default defineConfig({",
          "  dialect: postgres(),",
          '  schema: { file: "schema.json" }, outDir: "generated", projects: ["tsconfig.json"],',
          '  manifest: { outFile: ".typed-sql/queries.json" },',
          '  verification: { live, proofFile: ".typed-sql/verification.json", concurrency: 2 },',
          "});",
        ].join("\n"),
      );
      await writeFile(
        join(temporary, "schema.json"),
        `${JSON.stringify({
          formatVersion: 1,
          dialect: "postgres",
          tables: {
            users: {
              name: "users",
              columns: { id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false } },
            },
          },
        })}\n`,
      );
      await writeFile(
        join(temporary, "tsconfig.json"),
        `${JSON.stringify({ extends: "../tsconfig.base.json", include: ["src/**/*.ts"] })}\n`,
      );
      await writeFile(
        join(temporary, "src", "query.ts"),
        'import { sql } from "@typed-sql/postgres"; export const query = sql`SELECT users.id FROM users`;\n',
      );

      await execute(["manifest"], temporary);
      const live = await execute(["verify", "--live"], temporary);
      strict.match(live.stdout, /Verified 1 variants \(0 mismatched, 0 skipped, 0 failed\)/u);
      const proofFile = join(temporary, ".typed-sql", "verification.json");
      const proof = await readFile(proofFile, "utf8");
      strict.ok(!proof.includes("SELECT"));
      strict.ok(!proof.includes(temporary));

      const cached = await execute(["verify"], temporary);
      strict.match(cached.stdout, /Cached verification is current \(1 entries\)/u);

      const manifestFile = join(temporary, ".typed-sql", "queries.json");
      const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { schemaHash: string };
      manifest.schemaHash = "c".repeat(64);
      await writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
      await strict.rejects(execute(["verify"], temporary), /stale/u);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

await describe("typed-sql explain command", async () => {
  await it("captures redacted plans, reviews budgets, and distinguishes incomparable evidence", async () => {
    const temporary = await mkdtemp(join(workspace, ".typed-sql-cli-explain-"));
    try {
      await mkdir(join(temporary, "src"));
      const writeConfig = async (version: string, cost: number) =>
        writeFile(
          join(temporary, "typed-sql.config.ts"),
          [
            'import { defineConfig } from "@typed-sql/core";',
            'import { postgres } from "@typed-sql/postgres";',
            "const live = {",
            '  dialect: "postgres", adapterVersion: "fake-explain-v1", parameterMode: "value-free",',
            `  async environment() { return { version: ${JSON.stringify(version)}, settings: { plan_cache_mode: "auto" }, statisticsFingerprint: "sha256:${"a".repeat(64)}" }; },`,
            `  async capture() { return { totalCost: ${cost}, estimatedRows: 1, nodes: [{ kind: "Index Scan", relation: "users" }] }; },`,
            "  async close() {},",
            "};",
            "export default defineConfig({",
            "  dialect: postgres(),",
            '  schema: { file: "schema.json" }, outDir: "generated", projects: ["tsconfig.json"],',
            '  manifest: { outFile: ".typed-sql/queries.json" },',
            '  plans: { live, artifactFile: ".typed-sql/plans.json", reportFile: ".typed-sql/plan-review.json", failOn: "none", budgets: { defaults: { maximumTotalCost: 5, maximumTotalCostIncreaseRatio: 1.1 } } },',
            "});",
          ].join("\n"),
        );
      await writeConfig("18.4", 10);
      await writeFile(
        join(temporary, "schema.json"),
        `${JSON.stringify({
          formatVersion: 1,
          dialect: "postgres",
          tables: {
            users: {
              name: "users",
              columns: { id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false } },
            },
          },
        })}\n`,
      );
      await writeFile(
        join(temporary, "tsconfig.json"),
        `${JSON.stringify({ extends: "../tsconfig.base.json", include: ["src/**/*.ts"] })}\n`,
      );
      await writeFile(
        join(temporary, "src", "query.ts"),
        'import { sql } from "@typed-sql/postgres"; export const query = sql`SELECT users.id FROM users`;\n',
      );

      await execute(["manifest"], temporary);
      const first = await execute(["explain"], temporary);
      strict.match(first.stdout, /Captured 1 plans.*1 violations/u);
      strict.match(first.stderr, /total-cost/u);
      const baseline = await readFile(join(temporary, ".typed-sql", "plans.json"), "utf8");
      strict.ok(!baseline.includes("SELECT"));
      strict.ok(!baseline.includes(temporary));

      await writeConfig("19.0", 4);
      const next = await execute(
        ["explain", "--compare", ".typed-sql/plans.json", "--out", ".typed-sql/current.json"],
        temporary,
      );
      strict.match(next.stdout, /1 incomparable/u);
      strict.match(next.stderr, /server-version-changed/u);
      await strict.rejects(
        execute(["explain", "--fail-on", "uncertainty", "--compare", ".typed-sql/plans.json"], temporary),
        (error: unknown) => error instanceof Error && "code" in error && error.code === 1,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
