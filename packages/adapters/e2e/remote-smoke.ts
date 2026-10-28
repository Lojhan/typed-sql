import { createClient } from "@libsql/client";
import { neon, neonConfig, Pool } from "@neondatabase/serverless";
import { sql, withQueryValuePlan } from "@typed-sql/core";
import { normalizePostgresValue, postgresRenderer } from "@typed-sql/postgres/query";
import { sqliteRenderer } from "@typed-sql/sqlite/query";
import { it, strict } from "poku";
import postgres from "postgres";
import * as ws from "ws";
import type { BufferedDatabase } from "../src/index.js";
import { createLibsqlDatabase } from "../src/libsql.js";
import { createNeonHttpDatabase } from "../src/neon-http.js";
import { createNeonWebSocketDatabase } from "../src/neon-ws.js";
import { createPostgresJsDatabase } from "../src/postgres-js.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} explicitly for this read-only remote smoke`);
  return value;
}

const target = required("TYPED_SQL_REMOTE_ADAPTER");
if (!["d1", "libsql", "neon-http", "neon-ws", "postgres-js"].includes(target))
  throw new Error("TYPED_SQL_REMOTE_ADAPTER must be d1, libsql, neon-http, neon-ws, or postgres-js");

await it(`runs the explicitly selected ${target} remote read-only transport`, async () => {
  const profile = {
    id: "remote-smoke",
    dialect: "postgres",
    integer: "lossless",
    jsonWire: "text",
    normalizeValue: normalizePostgresValue,
  } as const;
  const check = async (database: BufferedDatabase, dialect = "postgres") => {
    const query = withQueryValuePlan(sql<{ value: number }>`SELECT ${7} AS value`, {
      dialect,
      typePolicyHash: "typed-sql-read-only-smoke",
      columns: [{ name: "value", type: "number", nullable: false }],
      parameters: [{ index: 1, type: "number", nullable: false }],
    });
    strict.deepEqual(await database.all(query), [{ value: 7 }]);
  };
  // Errors from third-party drivers can contain connection URLs. Keep credentials out of logs.
  try {
    if (target === "d1") {
      const response = await fetch(required("TYPED_SQL_D1_SMOKE_URL"), {
        headers: { authorization: `Bearer ${required("TYPED_SQL_D1_SMOKE_TOKEN")}` },
        signal: AbortSignal.timeout(30_000),
      });
      strict.equal(response.status, 200);
      strict.deepEqual(await response.json(), { adapter: "d1", rows: [{ value: 7 }] });
    } else if (target === "libsql") {
      const client = createClient({
        url: required("TYPED_SQL_LIBSQL_URL"),
        authToken: required("TYPED_SQL_LIBSQL_AUTH_TOKEN"),
        intMode: "bigint",
      });
      try {
        await check(
          createLibsqlDatabase(client, {
            renderer: sqliteRenderer,
            profile: { id: "remote-smoke", dialect: "sqlite", integer: "lossless", jsonWire: "text" },
          }),
          "sqlite",
        );
      } finally {
        client.close();
      }
    } else if (target === "neon-http") {
      await check(
        createNeonHttpDatabase(neon(required("TYPED_SQL_NEON_URL"), { fullResults: true }), {
          renderer: postgresRenderer,
          profile,
        }),
      );
    } else if (target === "neon-ws") {
      neonConfig.webSocketConstructor = ws.WebSocket;
      const pool = new Pool({ connectionString: required("TYPED_SQL_NEON_URL"), connectionTimeoutMillis: 30_000 });
      try {
        await check(createNeonWebSocketDatabase(pool, { renderer: postgresRenderer, profile }));
      } finally {
        await pool.end();
      }
    } else {
      const client = postgres(required("TYPED_SQL_POSTGRES_URL"), { max: 1, connect_timeout: 30 });
      try {
        await check(createPostgresJsDatabase(client, { renderer: postgresRenderer, profile }));
      } finally {
        await client.end();
      }
    }
  } catch {
    throw new Error(
      `${target} remote smoke failed; connection details were withheld. Check the selected endpoint, permissions, and provider logs.`,
    );
  }
});
