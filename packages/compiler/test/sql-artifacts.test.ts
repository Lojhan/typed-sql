import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { type DialectPlugin, renderQuery } from "../../core/src/index.js";
import { mysql } from "../../mysql/src/index.js";
import { postgres } from "../../postgres/src/index.js";
import { withSchemaBrands } from "../../schema/src/index.js";
import { SqliteSchemaProvider, sqlite } from "../../sqlite/src/index.js";
import { sqliteRenderer } from "../../sqlite/src/runtime.js";
import {
  analyzeSchemaCompatibility,
  buildQueryManifest,
  captureQueryPlans,
  collectQueryVerificationCandidates,
  compileSqlFile,
  listProjectSourceFiles,
  parseQueryManifest,
  serializeQueryManifest,
  verifyQueryManifest,
} from "../src/index.js";

await describe("SQL asset artifact workflows", async () => {
  for (const dialect of [postgres(), mysql(), sqlite()] as readonly DialectPlugin[]) {
    await it(`includes ${dialect.id} assets in manifests, verification, plans and compatibility`, async () => {
      const rootDir = "/portable/sql-app";
      const schema = dialect.validateSnapshot({
        dialect: dialect.id,
        tables: {
          users: {
            name: "users",
            strict: true,
            columns: {
              id: {
                name: "id",
                databaseType: dialect.id === "sqlite" ? "INTEGER" : "bigint",
                tsType: "bigint",
                nullable: false,
              },
              email: { name: "email", databaseType: "text", tsType: "string", nullable: false },
            },
          },
        },
      });
      const sources = [
        { file: `${rootDir}/find.sql`, source: "SELECT id, email FROM users WHERE id = :id OR id = :id" },
      ];
      const options = { rootDir, sources, dialect, schema, compilerVersion: "test" };
      const manifest = buildQueryManifest(options).manifest;
      strict.strictEqual(manifest.queries.length, 1);
      strict.strictEqual(manifest.queries[0]?.status, "resolved");
      strict.deepStrictEqual(parseQueryManifest(JSON.parse(serializeQueryManifest(manifest))), manifest);
      const candidates = collectQueryVerificationCandidates({ ...options, manifest });
      strict.strictEqual(candidates.length, 1);
      const candidate = candidates[0]!;
      strict.ok(!candidate.sql.includes(":id"));
      strict.deepStrictEqual(
        candidate.parameters.map((parameter) => parameter.tsType),
        ["bigint", "bigint"],
      );
      strict.strictEqual(candidate.source.range.start, 0);
      strict.strictEqual(candidate.source.range.end, sources[0]!.source.length);
      const dependency =
        manifest.queries[0]?.status === "resolved"
          ? manifest.queries[0].semantics.dependencies.find((item) => item.name === "users")
          : undefined;
      strict.ok(dependency);
      strict.strictEqual(sources[0]!.source.slice(dependency!.range.start, dependency!.range.end), "users");
      const seen: string[] = [];
      const verification = await verifyQueryManifest({
        manifest,
        candidates,
        verifier: {
          dialect: dialect.id,
          adapterVersion: "test",
          async server() {
            return { version: "test", features: [] };
          },
          async verify(request) {
            seen.push(request.sql);
            return { columns: candidate.columns, parameters: candidate.parameters };
          },
          async close() {},
        },
      });
      strict.strictEqual(verification.verified, 1);
      const plans = await captureQueryPlans({
        manifest,
        candidates,
        inspector: {
          dialect: dialect.id,
          adapterVersion: "test",
          parameterMode: "value-free",
          async environment() {
            return { version: "test", settings: {}, statisticsFingerprint: `sha256:${"a".repeat(64)}` };
          },
          async capture(request) {
            seen.push(request.sql);
            return { totalCost: 1, estimatedRows: 1, nodes: [] };
          },
          async close() {},
        },
      });
      strict.strictEqual(plans.captured, 1);
      strict.deepStrictEqual(seen, [candidate.sql, candidate.sql]);
      strict.ok(!JSON.stringify([manifest, verification.proof, plans.artifact]).includes("SELECT id"));
      strict.throws(
        () =>
          collectQueryVerificationCandidates({
            ...options,
            manifest,
            sources: [{ ...sources[0]!, source: `${sources[0]!.source} AND id > 0` }],
          }),
        /stale/u,
      );
      const after = dialect.validateSnapshot({
        ...schema,
        formatVersion: 1,
        tables: { users: { ...schema.tables.users!, columns: { id: schema.tables.users!.columns.id! } } },
      });
      const afterManifest = buildQueryManifest({ ...options, schema: after }).manifest;
      strict.strictEqual(afterManifest.queries[0]?.status, "unresolved");
      const compatibility = analyzeSchemaCompatibility({
        before: schema,
        after,
        beforeManifest: manifest,
        afterManifest,
      });
      strict.ok(
        compatibility.changes.some((change) => change.kind === "column-removed" && change.target.name === "email"),
      );
      strict.ok(JSON.stringify(compatibility).includes("find.sql"));
    });
  }

  await it("retains original diagnostic codes, severity and EOF ranges in SQL manifests", () => {
    const base = postgres();
    const schema = base.validateSnapshot({ dialect: "postgres", tables: {} });
    const rootDir = "/portable/app";
    const source = "SELECT 1 AS value";
    const dialect = {
      ...base,
      analyze: (...args: Parameters<typeof base.analyze>) => ({
        ...base.analyze(...args),
        diagnostics: [
          {
            code: "TSQ777",
            severity: "warning" as const,
            message: "warning",
            range: { start: source.length, end: source.length, line: 1, column: source.length + 1 },
          },
        ],
      }),
    };
    const manifest = buildQueryManifest({
      rootDir,
      sources: [{ file: `${rootDir}/query.sql`, source }],
      dialect,
      schema,
      compilerVersion: "test",
    }).manifest;
    const entry = manifest.queries[0]!;
    strict.strictEqual(entry.status, "resolved");
    strict.deepStrictEqual(
      entry.diagnostics.map((item) => [item.code, item.severity, item.range.start]),
      [["TSQ777", "warning", source.length]],
    );
    const invalid = buildQueryManifest({
      rootDir,
      sources: [{ file: `${rootDir}/query.sql`, source: "SELECT id FROM" }],
      dialect: base,
      schema,
      compilerVersion: "test",
    }).manifest;
    strict.strictEqual(invalid.queries[0]?.status, "unresolved");
    strict.ok(invalid.queries[0]!.diagnostics.length > 0);
  });

  await it("executes a generated repeated-name factory against native SQLite", async () => {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major === 22 && minor! < 13) return;
    const { DatabaseSync } = await import("node:sqlite");
    const native = new DatabaseSync(":memory:");
    try {
      native.exec(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL) STRICT; INSERT INTO users VALUES (7, 'Ada');",
      );
      const dialect = sqlite();
      const snapshot = await new SqliteSchemaProvider({
        client: {
          all<Row extends Record<string, unknown>>(sql: string): readonly Row[] {
            return native.prepare(sql).all() as unknown as readonly Row[];
          },
        },
      }).introspect();
      const schema = withSchemaBrands(snapshot, { columns: { users: { id: "UserId" } } });
      const result = compileSqlFile({
        dialect,
        schema,
        source: "SELECT id, email FROM users WHERE id = :id OR id = :id",
      });
      strict.deepStrictEqual(result.diagnostics, []);
      strict.match(result.text, /Brand<bigint, "UserId">/u);
      const runtime = result.runtime.replaceAll(
        JSON.stringify(dialect.runtimeSqlModule),
        JSON.stringify(new URL("../../sqlite/dist/packages/sqlite/src/query.js", import.meta.url).href),
      );
      const factory = (await import(`data:text/javascript;base64,${Buffer.from(runtime).toString("base64")}`)).default;
      const rendered = renderQuery(factory({ id: 7n }), sqliteRenderer);
      const statement = native.prepare(rendered.text);
      statement.setReadBigInts(true);
      strict.deepStrictEqual(
        statement.all(...(rendered.values as readonly bigint[])).map((row) => ({ ...row })),
        [{ id: 7n, email: "Ada" }],
      );
    } finally {
      native.close();
    }
  });

  await it("discovers imported SQL sources without collecting unrelated migrations or string lookalikes", async () => {
    const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const directory = await mkdtemp(join(workspace, ".typed-sql-sql-discovery-"));
    try {
      await mkdir(join(directory, "src"));
      await writeFile(
        join(directory, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { noEmit: true, types: [], target: "ES2024", module: "NodeNext" },
          files: ["src/index.ts"],
        }),
      );
      await writeFile(
        join(directory, "src/index.ts"),
        `import find from './find.sql'; export { default as other } from './other.sql';\nconst fake = "import q from './fake.sql'"; // import x from './comment.sql'\nvoid find;`,
      );
      for (const name of ["find", "other", "migration"])
        await writeFile(join(directory, `src/${name}.sql`), "SELECT 1 AS value");
      const files = await listProjectSourceFiles({
        project: join(directory, "tsconfig.json"),
        cwd: workspace,
        includeSqlAssets: true,
      });
      strict.deepStrictEqual(
        files,
        ["find.sql", "index.ts", "other.sql"].map((name) => join(directory, "src", name)),
      );
      await rm(join(directory, "src/find.sql"));
      await strict.rejects(
        listProjectSourceFiles({ project: join(directory, "tsconfig.json"), cwd: workspace, includeSqlAssets: true }),
        /find.sql/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
