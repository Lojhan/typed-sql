import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFORMANCE_VERSION,
  type ConformanceLiveAdapter,
  type ConformanceServerErrorClass,
  type ConformanceTypeNormalizer,
  createConformanceReport,
  createConformanceReproductionBundle,
  defineConformanceProbe,
  runLiveConformanceProbe,
  runStaticConformanceProbe,
  selectExpectedOutcome,
  serializeConformanceReport,
  serializeConformanceReproductionBundle,
} from "@typed-sql/conformance/v2";
import { sql, sqlite, typePolicy } from "@typed-sql/sqlite";
import { createNodeSqliteDatabase } from "@typed-sql/sqlite/node-sqlite";
import { describe, it, strict } from "poku";
import { insertSmallAccountBatch, loadAccountWorkspace } from "../src/batches.js";
import { sqliteExecutionCapabilities } from "../src/capabilities.js";
import { findAccount, listActiveAccounts, requireAccount } from "../src/cardinality.js";
import { deleteAccount, deleteProjectsByOwner, updateAccountStatus } from "../src/mutations.js";
import { prepareAccountQueries } from "../src/prepared.js";
import { accountProjectSummary } from "../src/queries.js";
import { collectActiveAccounts, firstActiveAccount } from "../src/streams.js";
import { createAccountWithProject } from "../src/transactions.js";
import { validatedAccountById } from "../src/validation.js";
import { databasePath } from "../typed-sql.config.js";

const database = await createNodeSqliteDatabase({ path: databasePath, typePolicy });
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = resolve(packageDirectory, "../..");
const generatedSnapshotPath = join(packageDirectory, "generated", "db", "schema.json");

function rowValue(row: unknown): Readonly<Record<string, unknown>> {
  if (row === null || typeof row !== "object") throw new TypeError("Expected a SQLite row object");
  return { ...row };
}

async function removeAccounts(ids: readonly bigint[]): Promise<void> {
  for (const id of ids) {
    await database.execute(deleteProjectsByOwner(id));
    await database.execute(deleteAccount(id));
  }
}

try {
  await describe("SQLite example against node:sqlite", async () => {
    await it("executes queries, cardinality, CTEs, prepared statements, batches, and streams", async () => {
      strict.strictEqual((await listActiveAccounts(database)).length, 1);
      strict.deepStrictEqual(rowValue(await requireAccount(database, 1n)), {
        id: 1n,
        email: "alice@example.com",
        status: "active",
      });
      strict.strictEqual(await findAccount(database, -1n), undefined);
      strict.strictEqual((await database.all(accountProjectSummary)).length, 2);

      const prepared = prepareAccountQueries(database);
      strict.strictEqual(prepared.accountById.statementName, "example-account-by-id");
      strict.deepStrictEqual(rowValue(await database.one(prepared.accountById(2n))), {
        id: 2n,
        email: "bob@example.com",
        status: "suspended",
      });
      strict.strictEqual((await loadAccountWorkspace(database, 1n)).projects.length, 1);
      strict.strictEqual((await collectActiveAccounts(database)).length, 1);
      strict.deepStrictEqual(rowValue((await firstActiveAccount(database))!), {
        id: 1n,
        email: "alice@example.com",
        status: "active",
        budget: 12500.5,
      });
      strict.deepStrictEqual(rowValue(await database.one(validatedAccountById(1n))), {
        id: 1n,
        email: "alice@example.com",
        status: "active",
      });
      strict.deepStrictEqual(sqliteExecutionCapabilities(database), { cancellation: false, deadlines: false });
    });

    await it("commits typed mutations atomically", async () => {
      await removeAccounts([9_001n]);
      const created = await createAccountWithProject(
        database,
        { id: 9_001n, email: "transaction.sqlite@example.com", status: "active" },
        { id: 9_001n, name: "SQLite transaction", budget: 42.5 },
      );
      strict.deepStrictEqual(rowValue(created.account), {
        id: 9_001n,
        email: "transaction.sqlite@example.com",
        status: "active",
      });
      strict.deepStrictEqual(rowValue(await database.one(updateAccountStatus(9_001n, "suspended"))), {
        id: 9_001n,
        email: "transaction.sqlite@example.com",
        status: "suspended",
      });
      await removeAccounts([9_001n]);
      strict.strictEqual(await findAccount(database, 9_001n), undefined);
    });

    await it("uses a transaction batch for small inserts without claiming a native bulk protocol", async () => {
      const ids = [9_101n, 9_102n] as const;
      await removeAccounts(ids);
      const results = await insertSmallAccountBatch(database, [
        { id: ids[0], email: "batch-one.sqlite@example.com", status: "active" },
        { id: ids[1], email: "batch-two.sqlite@example.com", status: "suspended" },
      ]);
      strict.strictEqual(results.length, 2);
      strict.deepStrictEqual(rowValue(await requireAccount(database, ids[1])), {
        id: ids[1],
        email: "batch-two.sqlite@example.com",
        status: "suspended",
      });
      await removeAccounts(ids);
    });

    await it("executes SQLite recursive compounds with positional members", async () => {
      const rows = await database.execute(sql`
        WITH RECURSIVE cnt(value) AS (
          SELECT ${1n}
          UNION ALL
          SELECT value + 1 FROM cnt WHERE value < ${3n}
        )
        SELECT value FROM cnt
      `);
      strict.deepStrictEqual(
        rows.map((row) => rowValue(row).value),
        [1n, 2n, 3n],
      );
    });

    await it("executes chained SQLite windows and explicit frames", async () => {
      const rows = await database.execute(sql`
        SELECT
          id,
          ROW_NUMBER() OVER ordered AS position,
          LAG(email, 1, 'missing') OVER ordered AS previous,
          SUM(id) OVER (ordered ROWS BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE TIES) AS running_id
        FROM account
        WINDOW ordered AS (ORDER BY id)
        ORDER BY id
      `);
      strict.deepStrictEqual(rows.map(rowValue), [
        { id: 1n, position: 1n, previous: "missing", running_id: 1n },
        { id: 2n, position: 2n, previous: "alice@example.com", running_id: 3n },
      ]);
    });

    await it("executes SQLite UPSERT, RETURNING, and UPDATE FROM", async () => {
      await removeAccounts([9_201n]);
      const inserted = await database.execute(sql`
        INSERT INTO account (id, email, status)
        VALUES (${9_201n}, ${"upsert.sqlite@example.com"}, ${"active"})
        ON CONFLICT (id) DO UPDATE SET
          email = excluded.email,
          status = excluded.status
        RETURNING id, email, status
      `);
      strict.deepStrictEqual(rowValue(inserted[0]), {
        id: 9_201n,
        email: "upsert.sqlite@example.com",
        status: "active",
      });
      const updated = await database.execute(sql`
        UPDATE account
        SET status = source.status
        FROM account AS source
        WHERE account.id = ${9_201n} AND source.id = ${2n}
        RETURNING id, status
      `);
      strict.deepStrictEqual(rowValue(updated[0]), { id: 9_201n, status: "suspended" });
      await removeAccounts([9_201n]);
    });

    await it("records a redacted conformance v2 differential report", async () => {
      const dialect = sqlite();
      const snapshot = dialect.validateSnapshot(JSON.parse(await readFile(generatedSnapshotPath, "utf8")));
      if (snapshot.formatVersion !== 2) throw new TypeError("The SQLite conformance run requires snapshot v2");
      if (snapshot.metadata === undefined) throw new TypeError("The generated SQLite snapshot requires metadata");
      const query = sql`SELECT id FROM account WHERE id = ${1n}`;
      const versionRows = await database.execute(sql`SELECT sqlite_version() AS version`);
      const version = String(rowValue(versionRows[0]).version);
      const target = {
        grammar: "sqlite",
        grammarVersion: dialect.grammarVersion,
        databaseVersion: version,
      } as const;
      const probe = defineConformanceProbe({
        version: CONFORMANCE_VERSION,
        id: "sqlite.statement.select.live-bigint",
        featureId: "statement.select",
        grammar: "sqlite",
        targets: [target],
        source: "SELECT id FROM account WHERE id = ?",
        schemaFixture: "examples/sqlite/schema/catalog.snapshot.json",
        query,
        compilerSource:
          'import { sql } from "@typed-sql/sqlite";\nexport const query = sql`SELECT id FROM account WHERE id = ${1n}`;',
        live: { execute: true, maximumRows: 1 },
        expected: [
          {
            target: { grammarVersion: dialect.grammarVersion, databaseVersion: version },
            support: "conservative",
            rows: [
              {
                name: "id",
                tsType: "bigint",
                nullable: false,
                databaseType: "INTEGER",
                range: { start: 7, end: 9, line: 1, column: 8 },
              },
            ],
            parameters: [{ index: 1, tsType: "bigint", nullable: false, databaseType: "INTEGER" }],
            diagnostics: [],
            rendered: { text: "SELECT id FROM account WHERE id = ?", values: [1n] },
            compiled: { rowType: '{ "id": bigint; }', parameterType: "readonly [bigint]" },
            decodedRows: [{ id: 1n }],
            skips: {
              "lex-parse": "grammar-parser-private",
              prepare: "no-server-metadata",
              plan: "plan-format-unstable",
            },
          },
        ],
      });
      const requestedProbe = process.env.TYPED_SQL_CONFORMANCE_PROBE;
      if (requestedProbe !== undefined && requestedProbe !== probe.id) {
        throw new TypeError(`SQLite live suite does not contain requested probe ${requestedProbe}`);
      }
      const requestedDatabaseVersion = process.env.TYPED_SQL_CONFORMANCE_DATABASE_VERSION;
      if (requestedDatabaseVersion !== undefined && requestedDatabaseVersion !== version) {
        throw new TypeError(`Requested SQLite ${requestedDatabaseVersion}, connected to ${version}`);
      }
      const requestedFixtureGroup = process.env.TYPED_SQL_CONFORMANCE_FIXTURE_GROUP;
      if (requestedFixtureGroup !== undefined && requestedFixtureGroup !== "statement.select") {
        throw new TypeError(`SQLite live suite does not contain fixture group ${requestedFixtureGroup}`);
      }
      const adapter: ConformanceLiveAdapter = {
        grammar: "sqlite",
        driver: "node:sqlite",
        driverVersion: process.versions.node,
        async server() {
          return { version, capabilities: {} };
        },
        async prepare() {
          return { columns: [], parameters: [], unavailable: ["columns", "parameters", "nullability"] };
        },
        execute: async () => (await database.execute(query)).map(rowValue),
        classify(error): ConformanceServerErrorClass {
          const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
          if (code.includes("ERROR")) return "semantic";
          if (code.includes("BUSY") || code.includes("LOCKED")) return "environment";
          return "semantic";
        },
        async cleanup() {},
        async close() {},
      };
      const normalizer: ConformanceTypeNormalizer = {
        column: (field) => ({
          name: field.name ?? "id",
          tsType: "bigint",
          nullable: field.nullable ?? false,
          databaseType: field.nativeType ?? "INTEGER",
        }),
        parameter: (field) => ({
          index: field.index,
          tsType: "bigint",
          nullable: field.nullable ?? false,
          databaseType: field.nativeType ?? "INTEGER",
        }),
      };
      const staticResult = runStaticConformanceProbe(probe, target, {
        dialect,
        snapshot,
        renderer: {
          placeholder: (index) => dialect.placeholder(index),
          quoteIdentifier: (identifier) => dialect.quoteIdentifier(identifier),
        },
      });
      const result = await runLiveConformanceProbe(probe, target, adapter, normalizer, staticResult);
      const report = createConformanceReport(
        "sqlite-live",
        {
          grammar: "sqlite",
          grammarVersion: dialect.grammarVersion,
          databaseVersion: version,
          driver: "node:sqlite",
          driverVersion: process.versions.node,
          runtime: "node",
          runtimeVersion: process.version,
          typescriptVersion: "7.0.2",
          schemaFingerprint: `sha256:${snapshot.metadata.schemaHash}`,
          capabilities: {},
        },
        [result],
      );
      const artifactDirectory = join(workspaceDirectory, "artifacts", "conformance");
      await mkdir(artifactDirectory, { recursive: true });
      const serialized = serializeConformanceReport(report);
      strict.ok(!serialized.includes("alice@example.com"));
      strict.ok(!serialized.includes("1n"));
      await writeFile(join(artifactDirectory, "sqlite.json"), serialized);
      if (result.status !== "pass") {
        const reproduction = createConformanceReproductionBundle(
          probe,
          target,
          report.environment,
          selectExpectedOutcome(probe, target),
          result,
        );
        await writeFile(
          join(artifactDirectory, "sqlite-reproduction.json"),
          serializeConformanceReproductionBundle(reproduction),
        );
      }
      strict.strictEqual(result.status, "pass", JSON.stringify(result, null, 2));
    });
  });
} finally {
  await removeAccounts([9_001n, 9_101n, 9_102n, 9_201n]).catch(() => undefined);
  await database.close();
}
