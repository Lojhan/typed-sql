import { type DatabaseOperationEnd, sql, withQueryValuePlan } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { it, strict } from "poku";
import { assertLegacyValuePlans } from "../../../test/helpers/legacy-value-plans.js";
import { createMySqlDatabase, type MySqlConnectionLike, type MySqlProtocolStream } from "../src/runtime.js";
import { defaultMySqlTypePolicy } from "../src/type-policy.js";

await it("enforces attached plans once across MySQL operations and retires rejected planned streams", async () => {
  let calls = 0;
  let closed = 0;
  const result = (values: readonly unknown[] = []) => ({
    rows: [{ doc: JSON.parse(String(values[0])) as unknown }],
    fields: [{ name: "doc", columnType: 245 }],
  });
  const connection: MySqlConnectionLike = {
    async execute(_text, values) {
      calls++;
      return result(values);
    },
    async query() {
      return { rows: [] };
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    destroy() {},
    release() {},
    stream(_text, values): MySqlProtocolStream {
      let sent = false;
      return {
        fields: Promise.resolve([{ name: "doc", columnType: 245 }]),
        connectionReusable: true,
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: result(values).rows[0]! };
        },
        async close() {
          closed++;
        },
      };
    },
  };
  const completions: DatabaseOperationEnd[] = [];
  const database = createMySqlDatabase({
    observer: {
      start() {
        return {
          end(completion) {
            completions.push(completion);
          },
        };
      },
    },
    pool: {
      executionCapabilities: { cancellation: true, deadlines: true },
      execute: connection.execute,
      getConnection: async () => connection,
      end: async () => {},
    },
  });
  const hash = calculateTypePolicyHash(defaultMySqlTypePolicy);
  await assertLegacyValuePlans(database, "mysql", hash);
  strict.equal(closed, 3);
  const query = withQueryValuePlan(sql`SELECT ${sql.json(["wrong"])} AS doc`, {
    dialect: "mysql",
    typePolicyHash: hash,
    columns: [],
    parameters: [
      {
        index: 1,
        type: "unknown",
        nullable: false,
        json: { shape: { kind: "array", element: { kind: "number" } }, representation: "parsed" },
      },
    ],
  });
  const before = calls;
  await strict.rejects(database.all(query), /JSON|json/u);
  const mismatch = withQueryValuePlan(sql`SELECT 1`, {
    dialect: "mysql",
    typePolicyHash: "wrong-policy",
    columns: [],
    parameters: [],
  });
  await strict.rejects(database.all(mismatch), /polic/u);
  strict.equal(calls, before);
  strict.ok(
    completions.some((completion) => completion.status === "error" && completion.errorType === "TSQL_QUERY_VALUE"),
  );
});

await it("validates owned JSON text before SQL NULL and parsed JSON become indistinguishable", async () => {
  let wire: unknown = "null";
  let calls = 0;
  const fields = [{ name: "doc", columnType: 245 }];
  const connection: MySqlConnectionLike = {
    async execute() {
      calls++;
      return { rows: [{ doc: wire }], fields };
    },
    async query() {
      return { rows: [] };
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    destroy() {},
    release() {},
    stream() {
      let sent = false;
      return {
        fields: Promise.resolve(fields),
        connectionReusable: true,
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          if (sent) return { done: true as const, value: undefined };
          sent = true;
          return { done: false as const, value: { doc: wire } };
        },
        async close() {},
      };
    },
  };
  const pool = { execute: connection.execute, getConnection: async () => connection, end: async () => {} };
  const database = createMySqlDatabase({ pool: { ...pool, jsonWire: "text" } });
  const query = withQueryValuePlan(sql`SELECT doc`, {
    dialect: "mysql",
    typePolicyHash: calculateTypePolicyHash(defaultMySqlTypePolicy),
    parameters: [],
    columns: [
      {
        name: "doc",
        type: "unknown",
        nullable: true,
        json: {
          representation: "parsed",
          requiresRuntimeValidation: true,
          shape: { kind: "object", properties: { id: { shape: { kind: "number" } } } },
        },
      },
    ],
  });
  await strict.rejects(database.all(query), /declared shape/);
  await strict.rejects(async () => {
    for await (const _row of database.stream(query)) {
    }
  }, /declared shape/);
  wire = null;
  strict.deepEqual(await database.all(query), [{ doc: null }]);
  wire = '{"id":1}';
  strict.deepEqual(await database.all(query), [{ doc: { id: 1 } }]);
  strict.deepEqual(await database.all(sql`SELECT doc`), [{ doc: { id: 1 } }]);
  wire = '{"id":"wrong"}';
  await strict.rejects(database.all(query), /declared shape/);
  const generic = createMySqlDatabase({ pool });
  const before = calls;
  await strict.rejects(generic.all(query), /distinguish/);
  strict.equal(calls, before);
});
