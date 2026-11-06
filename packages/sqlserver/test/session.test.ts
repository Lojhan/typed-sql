import { type DialectServerEvidence, defineDialectServerEvidence, sql, withQueryValuePlan } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import { createSqlServerDatabase, type SqlServerConnectionLike, type SqlServerProtocolStream } from "../src/runtime.js";
import { defaultSqlServerTypePolicy } from "../src/type-policy.js";
import { serverEvidence } from "./helpers/environment.js";

const query = withQueryValuePlan(sql<{ id: bigint }>`SELECT ${1n} AS id`, {
  dialect: "sqlserver",
  typePolicyHash: calculateTypePolicyHash(defaultSqlServerTypePolicy),
  columns: [{ name: "id", type: "bigint", nullable: false, databaseType: "bigint" }],
  parameters: [{ index: 1, type: "bigint", nullable: false, databaseType: "bigint" }],
});
function fixture() {
  let current = serverEvidence,
    reads = 0,
    count = 0,
    streams = 0;
  const calls: string[] = [];
  const connection: SqlServerConnectionLike = {
    executionCapabilities: { cancellation: true, deadlines: true },
    async readServerEvidence() {
      reads++;
      return current;
    },
    async execute(text) {
      calls.push(text);
      if (text.startsWith("SELECT @@TRANCOUNT")) return { rows: [{ count: String(count), state: count ? "1" : "0" }] };
      if (text === "BEGIN TRANSACTION") {
        count = 1;
        return { rows: [] };
      }
      if (text === "COMMIT TRANSACTION" || text.startsWith("IF @@TRANCOUNT")) {
        count = 0;
        return { rows: [] };
      }
      return { rows: [{ id: "1" }], fields: [{ name: "id" }] };
    },
    stream() {
      streams++;
      let done = false;
      const result: SqlServerProtocolStream = {
        fields: Promise.resolve([{ name: "id" }]),
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          if (done) return { done: true, value: undefined };
          done = true;
          return { done: false, value: { id: "1" } };
        },
        async close() {
          done = true;
        },
      };
      return result;
    },
  };
  const database = createSqlServerDatabase({ connection, serverEvidence });
  return {
    connection,
    database,
    calls,
    get reads() {
      return reads;
    },
    get streams() {
      return streams;
    },
    set current(evidence: DialectServerEvidence) {
      current = evidence;
    },
  };
}
const changed = (settings: Readonly<Record<string, string | number | boolean>>) =>
  defineDialectServerEvidence({ ...serverEvidence, settings: { ...serverEvidence.settings, ...settings } });
await describe("SQL Server lease-local native session attestation", async () => {
  await it("rejects critical settings, database and compatibility drift before typed dispatch", async () => {
    const state = fixture();
    strict.deepEqual(await state.database.one(query), { id: 1n });
    for (const settings of [
      { databaseName: "other" },
      { defaultSchema: "custom" },
      { compatibilityLevel: 160 },
      { collation: "Latin1_General_100_CI_AS" },
      { quotedIdentifier: false },
      { ansiWarnings: false },
      { arithAbort: false },
      { concatNullOn: false },
      { dateFirst: 1 },
      { dateFormat: "dmy" },
      { language: "British" },
      { engineEdition: 5 },
    ]) {
      state.current = changed(settings);
      const before = state.calls.length;
      await strict.rejects(() => state.database.all(query));
      strict.equal(state.calls.length, before);
    }
    state.current = defineDialectServerEvidence({ ...serverEvidence, version: "18.0.1.1", versionKey: "18" });
    await strict.rejects(() => state.database.all(query));
    state.current = serverEvidence;
    strict.deepEqual(await state.database.one(query), { id: 1n });
    strict.equal(Object.isFrozen(state.database.serverEvidence), true);
    await state.database.close();
  });
  await it("checks transaction entry and scoped typed requests under the same lease", async () => {
    const state = fixture();
    state.current = changed({ databaseName: "other" });
    await strict.rejects(() => state.database.transaction(async () => {}));
    strict.equal(state.calls.length, 0);
    state.current = serverEvidence;
    await strict.rejects(() =>
      state.database.transaction(async (scope) => {
        strict.deepEqual(await scope.one(query), { id: 1n });
        state.current = changed({ compatibilityLevel: 160 });
        await scope.all(query);
      }),
    );
    strict.equal(state.calls.filter((text) => text.startsWith("SELECT (CONVERT")).length, 1);
    strict.ok(state.calls.some((text) => text.startsWith("IF @@TRANCOUNT")));
    strict.equal(state.calls.includes("COMMIT TRANSACTION"), false);
    await state.database.close();
  });
  await it("keeps raw catalog/setup operations available for intentional session repair", async () => {
    const state = fixture();
    state.current = changed({ quotedIdentifier: false });
    await state.database.queryable.all("SET SHOWPLAN_XML OFF");
    strict.equal(state.reads, 0);
    strict.equal(state.calls[0], "SET SHOWPLAN_XML OFF");
    await strict.rejects(() => state.database.all(query));
    state.current = serverEvidence;
    await state.database.all(query);
    await state.database.close();
  });
  await it("attests lazy streams before native creation and does not dispatch after close during an evidence read", async () => {
    const state = fixture();
    state.current = changed({ databaseName: "other" });
    const invalid = state.database.stream(query);
    strict.equal(state.reads, 0);
    await strict.rejects(() => invalid.next());
    strict.equal(state.streams, 0);
    state.current = serverEvidence;
    let resolve!: (value: DialectServerEvidence) => void;
    state.connection.readServerEvidence = () =>
      new Promise((done) => {
        resolve = done;
      });
    const stream = state.database.stream(query),
      pending = stream.next();
    while (!resolve) await Promise.resolve();
    const closing = stream.close();
    await strict.rejects(() => state.database.all(query), /leased/);
    resolve(serverEvidence);
    await closing;
    strict.deepEqual(await pending, { done: true, value: undefined });
    strict.equal(state.streams, 0);
    await state.database.close();
  });
  await it("holds the shared lease throughout attestation and leaves injected attested connections usable without a hook", async () => {
    const state = fixture();
    let resolve!: (value: DialectServerEvidence) => void;
    state.connection.readServerEvidence = () =>
      new Promise((done) => {
        resolve = done;
      });
    const pending = state.database.all(query);
    while (!resolve) await Promise.resolve();
    await strict.rejects(() => state.database.all(query), /leased/);
    await strict.rejects(() => state.database.close(), /active request/);
    resolve(serverEvidence);
    await pending;
    await state.database.close();
    const connection = fixture().connection;
    delete connection.readServerEvidence;
    const injected = createSqlServerDatabase({ connection, serverEvidence });
    strict.deepEqual(await injected.one(query), { id: 1n });
    await injected.close();
  });
  await it("passes controls to an injected evidence hook and rechecks cancellation after it returns", async () => {
    const state = fixture(),
      controller = new AbortController();
    const deadline = Date.now() + 10000;
    state.connection.readServerEvidence = async (options) => {
      strict.equal(options?.signal, controller.signal);
      strict.equal(options?.deadline, deadline);
      controller.abort("cancelled between attestation and dispatch");
      return serverEvidence;
    };
    await strict.rejects(
      () => state.database.one(query, { signal: controller.signal, deadline }),
      (error) =>
        (error as { code?: unknown }).code === "TSQL_CANCELLED" &&
        (error as Error).cause === "cancelled between attestation and dispatch",
    );
    strict.equal(state.calls.length, 0);
    state.connection.readServerEvidence = async () => serverEvidence;
    strict.deepEqual(await state.database.one(query), { id: 1n });
    await state.database.close();
  });
});
