import { type DatabaseOperationEnd, sql, withQueryValuePlan } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { it, strict } from "poku";
import { assertLegacyValuePlans } from "../../../test/helpers/legacy-value-plans.js";
import { createPostgresDatabase, type PostgresClientLike, type PostgresQueryConfig } from "../src/runtime.js";
import { defaultPostgresTypePolicy } from "../src/type-policy.js";

await it("enforces attached plans once across PostgreSQL operations and rejects incompatible inputs before dispatch", async () => {
  const calls: (PostgresQueryConfig | string)[] = [];
  let closed = 0;
  let released = 0;
  const rows = (config: PostgresQueryConfig) => [{ doc: JSON.parse(String(config.values?.[0])) as unknown }];
  const client: PostgresClientLike = {
    pipeline: true,
    async query(config) {
      calls.push(config);
      return { rows: typeof config === "string" ? [] : rows(config) };
    },
    async openCursor(config) {
      let sent = false;
      return {
        async read() {
          if (sent) return [];
          sent = true;
          return rows(config);
        },
        async close() {
          closed++;
        },
      };
    },
    release() {
      released++;
    },
  };
  const completions: DatabaseOperationEnd[] = [];
  const database = createPostgresDatabase({
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
      query: client.query,
      connect: async () => client,
      end: async () => {},
    },
  });
  const hash = calculateTypePolicyHash(defaultPostgresTypePolicy);
  await assertLegacyValuePlans(database, "postgres", hash, (queries) => database.pipeline(queries));
  strict.equal(closed, 3, "successful and rejected planned streams close their cursor");
  strict.ok(released > 0);
  const query = withQueryValuePlan(sql`SELECT ${sql.json(["wrong"])} AS doc`, {
    dialect: "postgres",
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
  const before = calls.length;
  await strict.rejects(database.all(query), /JSON|json/u);
  const mismatch = withQueryValuePlan(sql`SELECT 1`, {
    dialect: "postgres",
    typePolicyHash: "wrong-policy",
    columns: [],
    parameters: [],
  });
  await strict.rejects(database.all(mismatch), /polic/u);
  strict.equal(calls.length, before);
  strict.ok(
    completions.some((completion) => completion.status === "error" && completion.errorType === "TSQL_QUERY_VALUE"),
  );
});
