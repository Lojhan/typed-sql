import { execFile as callback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";
import type { DialectPlugin } from "../../core/src/index.js";
import { mysql } from "../../mysql/src/index.js";
import { postgres } from "../../postgres/src/index.js";
import { parseSchemaSnapshot, withSchemaBrands } from "../../schema/src/index.js";
import { sqlite } from "../../sqlite/src/index.js";
import {
  buildQueryManifest,
  collectQueryVerificationCandidates,
  compileSqlFile,
  verifyQueryManifest,
} from "../src/index.js";

await describe("branded scalar query contracts", async () => {
  await it("retains brands through rows, parameters and projections with primitive wire plans in every grammar", async () => {
    const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const directory = await mkdtemp(join(workspace, "artifacts/brand-consumer-"));
    try {
      for (const dialect of [postgres(), mysql(), sqlite()] as readonly DialectPlugin[]) {
        const schema = withSchemaBrands(
          parseSchemaSnapshot(
            dialect.validateSnapshot({
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
                  },
                },
              },
            }),
          ),
          { columns: { users: { id: "UserId" } } },
        );
        const query = compileSqlFile({
          dialect,
          schema,
          source: "WITH selected AS (SELECT id FROM users) SELECT id FROM selected WHERE id = :id",
        });
        strict.deepStrictEqual(query.diagnostics, []);
        strict.match(query.text, /Brand<bigint, "UserId">/u);
        const analysis = dialect.analyze(`SELECT id FROM users WHERE id = ${dialect.placeholder(1)}`, schema);
        strict.deepStrictEqual(analysis.diagnostics, []);
        strict.match(analysis.parameters[0]!.tsType, /Brand<bigint, "UserId">/u);
        strict.strictEqual(dialect.runtimeValueType!(analysis.columns[0]!), "bigint");
        strict.strictEqual(dialect.runtimeValueType!(analysis.parameters[0]!), "bigint");
        const sources = [{ file: join(directory, `${dialect.id}.sql`), source: "SELECT id FROM users WHERE id = :id" }];
        const options = { rootDir: directory, sources, schema, dialect, compilerVersion: "test" };
        const manifest = buildQueryManifest(options).manifest;
        const candidates = collectQueryVerificationCandidates({ ...options, manifest });
        const verified = await verifyQueryManifest({
          manifest,
          candidates,
          verifier: {
            dialect: dialect.id,
            adapterVersion: "test",
            async server() {
              return { version: "test", features: [] };
            },
            async verify() {
              return {
                columns: [{ index: 1, name: "id", tsType: "bigint" }],
                parameters: [{ index: 1, tsType: "bigint" }],
              };
            },
            async close() {},
          },
        });
        strict.strictEqual(verified.verified, 1);
        await writeFile(join(directory, `${dialect.id}.d.sql.ts`), query.text);
      }
      await writeFile(
        join(directory, "consumer.ts"),
        `import { brandValue, type Brand } from '@typed-sql/core';
import pg from './postgres.sql'; import my from './mysql.sql'; import lite from './sqlite.sql';
const user: Brand<bigint, 'UserId'> = brandValue(7n, 'UserId');
const post = brandValue(7n, 'PostId');
for (const query of [pg, my, lite]) {
  query({ id: user });
  // @ts-expect-error A different brand cannot be used as UserId.
  query({ id: post });
  // @ts-expect-error Unbranded values require an explicit trust boundary.
  query({ id: 7n });
}
`,
      );
      await writeFile(
        join(directory, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: "ES2024",
            module: "NodeNext",
            allowArbitraryExtensions: true,
            types: [],
            skipLibCheck: true,
          },
          files: ["consumer.ts"],
        }),
      );
      await promisify(callback)(
        join(workspace, "node_modules/.bin/tsc"),
        ["--project", join(directory, "tsconfig.json")],
        { cwd: workspace },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
