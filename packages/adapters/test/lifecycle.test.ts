import { sql, withQueryValuePlan } from "@typed-sql/core";
import { it, strict } from "poku";
import { postgresRenderer } from "../../postgres/src/query.js";
import { sqliteRenderer } from "../../sqlite/src/query.js";
import { createLibsqlDatabase, type LibsqlClient } from "../src/libsql.js";
import { createNeonWebSocketDatabase, type NeonWsConnection } from "../src/neon-ws.js";

const profile = { id: "lifecycle", dialect: "postgres", integer: "lossless", jsonWire: "text" } as const;

await it("discards PostgreSQL connections with unproven state and preserves the original failure", async () => {
  for (const failed of ["BEGIN", "COMMIT", "ROLLBACK", "COMMIT+ROLLBACK"] as const) {
    const original = new Error(`original ${failed}`);
    const cleanup = new Error("cleanup failed");
    let released: Error | undefined;
    const connection: NeonWsConnection = {
      async query({ text }) {
        if (failed === "COMMIT+ROLLBACK" && (text === "COMMIT" || text === "ROLLBACK"))
          throw text === "COMMIT" ? original : cleanup;
        if (text === failed) throw failed === "ROLLBACK" ? cleanup : original;
        return { rows: [] };
      },
      release(error) {
        released = error;
      },
    };
    const database = createNeonWebSocketDatabase(
      { connect: async () => connection, query: connection.query },
      { renderer: postgresRenderer, profile },
    );
    await strict.rejects(
      database.transaction(async () => {
        if (failed === "ROLLBACK") throw original;
      }),
      (error: unknown) => error === original,
    );
    strict.equal(
      released !== undefined,
      failed !== "COMMIT",
      "successful ROLLBACK after failed COMMIT proves reusable state",
    );
  }
});

await it("drains unawaited scoped queries before commit and rejects escaped handles", async () => {
  const calls: string[] = [];
  let complete!: (result: { rows: { n: number }[] }) => void;
  const pending = new Promise<{ rows: { n: number }[] }>((resolve) => {
    complete = resolve;
  });
  const connection: NeonWsConnection = {
    async query({ text }) {
      calls.push(text);
      return text.startsWith("SELECT") ? pending : { rows: [] };
    },
    release() {
      calls.push("release");
    },
  };
  const database = createNeonWebSocketDatabase(
    { connect: async () => connection, query: connection.query },
    { renderer: postgresRenderer, profile },
  );
  const query = withQueryValuePlan(sql<{ n: number }>`SELECT 7 AS n`, {
    dialect: "postgres",
    typePolicyHash: "fixture",
    columns: [{ name: "n", type: "number", nullable: false }],
    parameters: [],
  });
  let escaped: Parameters<typeof database.transaction>[0] extends (scope: infer Scope) => unknown ? Scope : never;
  const transaction = database.transaction(async (scope) => {
    escaped = scope;
    void scope.all(query);
    return 7;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  strict.deepEqual(calls, ["BEGIN", "SELECT 7 AS n"]);
  complete({ rows: [{ n: 7 }] });
  strict.equal(await transaction, 7);
  strict.deepEqual(calls, ["BEGIN", "SELECT 7 AS n", "COMMIT", "release"]);
  await strict.rejects(escaped!.all(query), /no longer active/u);
});

await it("does not mask a libSQL callback failure with a rollback failure", async () => {
  const original = new Error("application failed");
  let closed = false;
  const client = {
    async transaction() {
      return {
        async execute() {
          return { rows: [] };
        },
        async commit() {},
        async rollback() {
          throw new Error("rollback failed");
        },
        close() {
          closed = true;
        },
      };
    },
    async execute() {
      return { rows: [] };
    },
    async batch() {
      return [];
    },
  } as unknown as LibsqlClient;
  const database = createLibsqlDatabase(client, {
    renderer: sqliteRenderer,
    profile: { ...profile, dialect: "sqlite" },
  });
  await strict.rejects(
    database.transaction(async () => {
      throw original;
    }),
    (error: unknown) => error === original,
  );
  strict.equal(closed, true);
});
