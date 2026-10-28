import { sql, withQueryValuePlan } from "@typed-sql/core";
import { sqliteRenderer } from "@typed-sql/sqlite/query";
import { createD1Database, type D1Binding } from "../../src/d1.js";

const query = withQueryValuePlan(sql<{ value: number }>`SELECT ${7} AS value`, {
  dialect: "sqlite",
  typePolicyHash: "typed-sql-read-only-smoke",
  columns: [{ name: "value", type: "number", nullable: false }],
  parameters: [{ index: 1, type: "number", nullable: false }],
});

/** Optional application-owned deployment: performs no writes or schema operations. */
export default {
  async fetch(request: Request, env: { DB: D1Binding; SMOKE_TOKEN: string }): Promise<Response> {
    if (!env.SMOKE_TOKEN || request.headers.get("authorization") !== `Bearer ${env.SMOKE_TOKEN}`)
      return new Response("Forbidden", { status: 403 });
    const database = createD1Database(env.DB, {
      renderer: sqliteRenderer,
      profile: {
        id: "d1-smoke",
        dialect: "sqlite",
        integer: "safe-number",
        jsonWire: "text",
        typePolicyHash: "typed-sql-read-only-smoke",
      },
    });
    return Response.json({ adapter: "d1", rows: await database.all(query) });
  },
};
