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
