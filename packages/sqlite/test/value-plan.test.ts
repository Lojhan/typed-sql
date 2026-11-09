import { type QueryValuePlan, sql, withQueryValuePlan } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import { buildQueryValuePlan } from "../../compiler/src/index.js";
import { sqlite } from "../src/analysis.js";
import { createNodeSqliteDatabase } from "../src/node-sqlite.js";
import { defaultSqliteTypePolicy } from "../src/type-policy.js";
import { accountTable, serverEvidence } from "./helpers/schema.js";

const identity = { dialect: "sqlite", typePolicyHash: calculateTypePolicyHash(defaultSqliteTypePolicy) };
const docColumn: QueryValuePlan["columns"][number] = {
  name: "doc",
  type: "string",
  nullable: false,
  json: { representation: "text", shape: { kind: "object", properties: { id: { shape: { kind: "number" } } } } },
};
const document = (text: string) =>
  withQueryValuePlan(sql`${sql.raw(text)}`, { ...identity, columns: [docColumn], parameters: [] });

await describe("native SQLite planned execution", async () => {
  await it("preserves numeric codecs through aggregation, CTEs, compounds and parameter contexts", async () => {
    for (const integer of ["bigint", "number"] as const) {
      const typePolicy = { ...defaultSqliteTypePolicy, integer };
      const dialect = sqlite({ typePolicy });
      const snapshot = dialect.validateSnapshot({
        formatVersion: 1,
        dialect: "sqlite",
        ...serverEvidence(),
        tables: {
          account: {
            ...accountTable(),
            columns: {
              ...accountTable().columns,
              id: { ...accountTable().columns.id, tsType: integer },
            },
          },
        },
      });
      const plan = (source: string) => {
        const result = dialect.analyze(source, snapshot);
        strict.deepEqual(result.diagnostics, []);
        const value = buildQueryValuePlan(dialect, result);
        strict.ok(!JSON.stringify(value).includes('"unknown"'), source);
        return value;
      };
      const database = await createNodeSqliteDatabase({ path: ":memory:", typePolicy });
      try {
        await database.execute(sql`CREATE TABLE account(id INTEGER NOT NULL,email TEXT NOT NULL,score REAL) STRICT`);
        await database.execute(sql`INSERT INTO account VALUES(1,'a',1.25),(2,'b',2.5)`);
        const threshold = integer === "bigint" ? 2n : 2;
        const total = integer === "bigint" ? 3n : 3;
        const source = "WITH totals AS (SELECT SUM(id) AS total FROM account) SELECT total FROM totals WHERE total>=?";
        const resolved = dialect.analyze(source, snapshot);
        const numericType = integer === "bigint" ? "bigint | number" : "number";
        strict.equal(resolved.columns[0]?.tsType, numericType);
        strict.equal(resolved.columns[0]?.nullable, true);
        strict.deepEqual(
          resolved.parameters.map(({ index, tsType }) => ({ index, tsType })),
          [{ index: 1, tsType: numericType }],
        );
        const range = resolved.columns[0]!.range;
        strict.equal(source.slice(range.start, range.end), "total");
        const query = withQueryValuePlan(
          sql`WITH totals AS (SELECT SUM(id) AS total FROM account) SELECT total FROM totals WHERE total>=${threshold}`,
          plan(source),
        );
        strict.deepEqual(await database.all(query), [{ total }]);
        strict.deepEqual(
          await database.all(
            withQueryValuePlan(
              sql`SELECT SUM(score) AS total FROM account`,
              plan("SELECT SUM(score) AS total FROM account"),
            ),
          ),
          [{ total: 3.75 }],
        );
        strict.deepEqual(
          await database.all(
            withQueryValuePlan(
              sql`SELECT SUM(id) AS total FROM account WHERE id>99`,
              plan("SELECT SUM(id) AS total FROM account WHERE id>99"),
            ),
          ),
          [{ total: null }],
        );
        const compound = "SELECT SUM(id) AS total FROM account UNION ALL SELECT SUM(score) AS total FROM account";
        strict.deepEqual(dialect.analyze(compound, snapshot).columns[0]?.runtimeType, {
          union: integer === "bigint" ? ["bigint", "number"] : ["number"],
        });
        strict.deepEqual(
          await database.all(
            withQueryValuePlan(
              sql`SELECT SUM(id) AS total FROM account UNION ALL SELECT SUM(score) AS total FROM account`,
              plan(compound),
            ),
          ),
          [{ total }, { total: 3.75 }],
        );
        const cast = withQueryValuePlan(
          sql`SELECT CAST(${1.5} AS NUMERIC) AS total`,
          plan("SELECT CAST(? AS NUMERIC) AS total"),
        );
        strict.deepEqual(await database.all(cast), [{ total: 1.5 }]);
        await strict.rejects(
          database.all(
            withQueryValuePlan(
              sql`WITH totals AS (SELECT SUM(id) AS total FROM account) SELECT total FROM totals WHERE total>=${"invalid"}`,
              plan(source),
            ),
          ),
        );
      } finally {
        await database.close();
      }
    }
  });

  await it("validates buffered, batched and streamed JSON and releases a failed cursor", async () => {
    const database = await createNodeSqliteDatabase({ path: ":memory:" });
    const valid = document("SELECT json_object('id', 1) AS doc");
    const invalid = document("SELECT 'not JSON' AS doc");
    try {
      strict.deepEqual(await database.one(valid), { doc: '{"id":1}' });
      strict.deepEqual(await database.batch([valid, valid]), [[{ doc: '{"id":1}' }], [{ doc: '{"id":1}' }]]);
      await strict.rejects(database.all(invalid), /invalid JSON/);
      await strict.rejects(database.batch([valid, invalid]), /invalid JSON/);
      const stream = database.stream(invalid);
      await strict.rejects(stream.next(), /invalid JSON/);
      strict.deepEqual(await database.one(valid), { doc: '{"id":1}' });
      await database.all(sql`CREATE TABLE events (payload TEXT)`);
      await strict.rejects(
        database.transaction(async (transaction) => {
          await transaction.all(sql`INSERT INTO events VALUES ('temporary')`);
          await transaction.all(invalid);
        }),
        /invalid JSON/,
      );
      strict.deepEqual(await database.all(sql`SELECT payload FROM events`), []);
    } finally {
      await database.close();
    }
  });
  await it("preserves JSON null and SQL NULL and rejects policy mismatch before dispatch", async () => {
    const database = await createNodeSqliteDatabase({ path: ":memory:" });
    const bind = (input: unknown) =>
      withQueryValuePlan(sql`SELECT json_type(${input}) AS kind`, {
        ...identity,
        columns: [{ name: "kind", type: "string", nullable: true }],
        parameters: [
          { index: 1, type: "unknown", nullable: true, json: { representation: "parsed", shape: { kind: "unknown" } } },
        ],
      });
    try {
      strict.deepEqual(await database.one(bind(sql.json(null))), { kind: "null" });
      strict.deepEqual(await database.one(bind(null)), { kind: null });
      await database.all(sql`CREATE TABLE items (id INTEGER)`);
      const mismatch = withQueryValuePlan(sql`INSERT INTO items VALUES (1)`, {
        ...identity,
        typePolicyHash: "other",
        columns: [],
        parameters: [],
      });
      await strict.rejects(database.all(mismatch), /policies/);
      strict.deepEqual(await database.all(sql`SELECT id FROM items`), []);
    } finally {
      await database.close();
    }
  });
});
