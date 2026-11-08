import { EventEmitter } from "node:events";
import { describe, it, strict } from "poku";
import { acquireNativeQueryContract } from "../../analysis/src/index.js";
import type { PgLiveVerifierClient } from "../src/pg.js";
import { createPgNativeContractAdapter, PostgresContractAcquisitionError } from "../src/pg-contracts.js";
import { describePgStatement } from "../src/pg-description.js";
import { postgresProfile, typePolicy } from "../src/profile.js";
import { renderer } from "../src/tag.js";

const schema = { formatVersion: 1, dialect: "postgres", tables: {} } as const;
const sql = "SELECT vendor_fn($1::bigint) AS score";
const profile = postgresProfile();
const occurrences = profile.parameterOccurrences!(sql, schema).map(({ index, range }) => ({
  index,
  start: range.start,
  end: range.end,
}));
function fixture(
  options: {
    context?: Record<string, unknown>;
    epochs?: readonly string[];
    noProtocol?: boolean;
    prepareError?: boolean;
    type?: { oid: number; name: string; modifier: boolean; element: number; namespace?: string; kind?: string };
    noTypes?: boolean;
    fail?: string;
    missingModifier?: boolean;
    noContext?: boolean;
    noFormattedType?: boolean;
    columns?: number;
  } = {},
) {
  const calls: string[] = [];
  let reads = 0,
    releases = 0;
  const epoch = () => options.epochs?.[reads++] ?? "0/100";
  const connection = Object.assign(new EventEmitter(), {
    parse() {
      calls.push("parse");
    },
    describe() {
      calls.push("describe");
    },
    sync() {
      calls.push("sync");
    },
  });
  type MockConnection = typeof connection;
  const client = {
    ...(options.noProtocol ? {} : { connection }),
    query(value: unknown) {
      if (typeof value !== "string") {
        const query = value as {
          submit(connection: MockConnection): void;
          handleRowDescription(value: unknown): void;
          handleReadyForQuery(): void;
          handleError(value: unknown): void;
        };
        query.submit(connection);
        if (options.prepareError) {
          query.handleError(Error("secret statement"));
          return;
        }
        connection.emit("parameterDescription", { dataTypeIDs: [options.type?.oid ?? 20] });
        query.handleRowDescription({
          fields: Array.from({ length: options.columns ?? 1 }, (_, position) => ({
            name: position ? `score_${position}` : "score",
            dataTypeID: options.type?.oid ?? 20,
            ...(options.missingModifier ? {} : { dataTypeModifier: -1 }),
          })),
        });
        query.handleReadyForQuery();
        return;
      }
      calls.push(value);
      if (options.fail && value.includes(options.fail)) return Promise.reject(Error("driver failure"));
      if (value.includes("AS fingerprint"))
        return Promise.resolve({
          rows: options.noContext
            ? []
            : [
                {
                  fingerprint: "a".repeat(64),
                  version: "18.3",
                  epoch: epoch(),
                  recovery: false,
                  temporary: "0",
                  first_schema: "pg_catalog",
                  strings: "on",
                  encoding: "UTF8",
                  extensions: 0,
                  ...options.context,
                },
              ],
        });
      if (value.includes("AS first_schema"))
        return Promise.resolve({
          rows: options.noContext
            ? []
            : [
                {
                  version: "18.3",
                  recovery: false,
                  temporary: "0",
                  first_schema: "pg_catalog",
                  strings: "on",
                  encoding: "UTF8",
                  ...options.context,
                },
              ],
        });
      if (value.includes("AS epoch")) return Promise.resolve({ rows: [{ epoch: epoch() }] });
      if (value.includes("typelem AS element"))
        return Promise.resolve({
          rows: options.noTypes
            ? []
            : [
                {
                  namespace: "pg_catalog",
                  kind: "b",
                  ...(options.type ?? { oid: 20, name: "bigint", modifier: false, element: 0 }),
                },
              ],
        });
      if (value.includes("format_type($1"))
        return Promise.resolve({ rows: options.noFormattedType ? [] : [{ name: options.type?.name ?? "bigint" }] });
      return Promise.resolve({ rows: [] });
    },
    release(error?: boolean) {
      releases++;
      calls.push(`release:${error ?? false}`);
    },
  } as unknown as PgLiveVerifierClient;
  const adapter = createPgNativeContractAdapter({
    pool: {
      async connect() {
        calls.push("connect");
        return client;
      },
    },
    schema,
  });
  return { adapter, calls, releases: () => releases };
}
await describe("PostgreSQL native contract adapter and lightweight profile", async () => {
  await it("provides rendering and lexical bindings without an eager analyzer", () => {
    strict.equal(Object.hasOwn(profile, "analyze"), false);
    strict.equal(profile.defaultTypePolicy.bigint, typePolicy.bigint);
    strict.equal(profile.runtimeSqlModule, "@typed-sql/postgres/tag");
    strict.equal(renderer.placeholder(2), "$2");
    strict.throws(() => renderer.placeholder(0), RangeError);
    strict.equal(renderer.quoteIdentifier('a"b'), '"a""b"');
    strict.equal(profile.validateSnapshot(schema).dialect, "postgres");
    strict.ok(Object.hasOwn(profile.resolveCapabilities!(schema), "arrays"));
    strict.deepEqual(
      profile.parameterOccurrences!("SELECT ':ignored', :named, $2", schema).map(({ index, name }) => ({
        index,
        name,
      })),
      [
        { index: 0, name: "named" },
        { index: 2, name: undefined },
      ],
    );
  });
  await it("describes protocol columns and parameter OIDs without executing candidate SQL", async () => {
    const { adapter, calls, releases } = fixture();
    const context = await adapter.inspectContext();
    const result = await acquireNativeQueryContract({
      adapter,
      context,
      candidate: { sql, parameterOccurrences: occurrences },
    });
    strict.equal(result.status, "acquired");
    if (result.status !== "acquired") throw Error("missing contract");
    strict.equal(result.contract.valuePlan.columns[0]!.type, "bigint");
    strict.equal(result.contract.valuePlan.parameters[0]!.type, "bigint");
    strict.equal(result.contract.nativeEvidence!.columns[0]!.nullable.status, "unknown");
    strict.ok(calls.includes("parse") && calls.includes("describe") && calls.includes("sync"));
    strict.ok(!calls.includes(sql));
    strict.equal(releases(), 2);
  });
  await it("reuses type interpretation within one description instead of adding a round trip per result column", async () => {
    const { adapter, calls } = fixture({ columns: 8 });
    const session = await adapter.open();
    try {
      strict.equal((await session.describe({ sql, parameterOccurrences: occurrences })).columns.length, 8);
    } finally {
      await session.close();
    }
    strict.equal(calls.filter((sql) => sql.includes("format_type($1")).length, 1);
  });
  await it("qualifies only the declared expression and cast scope", () => {
    const { adapter, calls } = fixture();
    for (const text of [
      "SELECT vendor_fn($1::bigint)",
      "SELECT lower('x'::text)",
      "SELECT abs(1)",
      "SELECT 1::integer",
      "SELECT true",
      "SELECT NULL::text",
    ])
      strict.equal(adapter.accept({ sql: text, parameterOccurrences: [] }).accepted, true, text);
    for (const text of [
      "SELECT * FROM users",
      "SELECT 'text'",
      "SELECT NULL",
      "SELECT x::public.custom FROM users",
      "SELECT vendor_fn('x')",
      "SELECT 1+2",
      "SELECT $1::custom",
      "SELECT DISTINCT 1",
      "SELECT 1 LIMIT 1",
      "SELECT 1 ORDER BY 1",
      "SELECT 1 UNION SELECT 2",
      "WITH x AS (SELECT 1) SELECT 1",
      "DELETE FROM users",
      "nonsense",
      "SELECT sum(1) OVER ()",
    ])
      strict.equal(adapter.accept({ sql: text, parameterOccurrences: [] }).accepted, false, text);
    strict.deepEqual(calls, []);
    strict.throws(
      () =>
        createPgNativeContractAdapter({
          pool: {
            connect: async () => {
              throw Error("must not connect");
            },
          },
          schema,
          statementTimeoutMs: 0,
        }),
      RangeError,
    );
  });
  await it("rejects unknown contexts, WAL changes, unavailable protocols and native failures", async () => {
    for (const context of [
      { version: "17.9" },
      { recovery: true },
      { temporary: "10" },
      { first_schema: "public" },
      { encoding: "LATIN1" },
      { strings: "off" },
      { extensions: 1 },
      { fingerprint: "invalid" },
    ]) {
      const value = fixture({ context });
      await strict.rejects(
        value.adapter.inspectContext(),
        (error: unknown) => error instanceof PostgresContractAcquisitionError && error.reason === "unsupported-context",
      );
      strict.equal(value.releases(), 1);
    }
    await strict.rejects(fixture({ noContext: true }).adapter.inspectContext(), /unsupported-context/u);
    const changed = fixture({ epochs: ["0/1", "0/2", "0/3", "0/4", "0/5", "0/6"] });
    await strict.rejects(changed.adapter.inspectContext(), /context-changed/u);
    strict.equal(changed.releases(), 3);
    await strict.rejects(fixture({ epochs: ["invalid"] }).adapter.open(), /unsupported-context/u);
    const cold = fixture({ epochs: ["0/1", "0/2"] });
    strict.ok(await cold.adapter.inspectContext());
    strict.equal(cold.releases(), 2);
    for (const options of [
      { noProtocol: true },
      { prepareError: true },
      { noTypes: true },
      { noFormattedType: true },
    ]) {
      const { adapter } = fixture(options);
      const session = await adapter.open();
      try {
        await strict.rejects(
          session.describe({ sql, parameterOccurrences: occurrences }),
          /protocol-unavailable|native-failure/u,
        );
      } finally {
        await session.close();
      }
    }
    const failed = fixture({ fail: "BEGIN" });
    await strict.rejects(failed.adapter.open(), /driver failure/u);
    strict.equal(failed.releases(), 1);
    const close = fixture({ fail: "ROLLBACK" });
    const session = await close.adapter.open();
    await strict.rejects(session.close(), /native-failure/u);
    strict.ok(close.calls.includes("release:true"));
  });
  await it("retains incomplete modifier and array/opaque representation evidence", async () => {
    for (const type of [
      { oid: 1700, name: "numeric", modifier: true, element: 0 },
      { oid: 1007, name: "integer[]", modifier: false, element: 23 },
      { oid: 90000, name: "custom", modifier: false, element: 0 },
      { oid: 90001, name: "bigint", modifier: false, element: 0, namespace: "public", kind: "d" },
    ]) {
      const { adapter } = fixture({ type, missingModifier: true });
      const session = await adapter.open();
      try {
        const evidence = await session.describe({ sql, parameterOccurrences: occurrences });
        strict.equal(evidence.columns[0]!.nativeType.status, "known");
        if (type.element || type.name === "custom" || type.namespace === "public")
          strict.equal(evidence.columns[0]!.runtimeType.status, "unknown");
      } finally {
        await session.close();
      }
    }
  });
  await it("supports cancellation and idempotent cleanup without using a closed session", async () => {
    const signal = AbortSignal.abort();
    const before = fixture();
    await strict.rejects(before.adapter.open(signal), { name: "AbortError" });
    strict.deepEqual(before.calls, []);
    const { adapter, releases } = fixture();
    const session = await adapter.open();
    await strict.rejects(session.context(signal), { name: "AbortError" });
    await strict.rejects(session.describe({ sql, parameterOccurrences: occurrences }, signal), { name: "AbortError" });
    await strict.rejects(
      session.describe({ sql: "SELECT * FROM users", parameterOccurrences: [] }),
      /unsupported-context/u,
    );
    await session.describe({ sql, parameterOccurrences: occurrences });
    await strict.rejects(session.describe({ sql, parameterOccurrences: occurrences }), /unsupported-context/u);
    await session.close();
    await session.close();
    strict.equal(releases(), 1);
    await strict.rejects(session.context(), /closed-session/u);
    strict.equal(describePgStatement({} as PgLiveVerifierClient, "name", sql), undefined);
  });
});
