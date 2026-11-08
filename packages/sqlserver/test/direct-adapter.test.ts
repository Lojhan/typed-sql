import { sql, withQueryValuePlan } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import { sqlserver } from "../src/analysis.js";
import { createSqlServerOdbcConnection, createSqlServerOdbcDatabase, sqlServerOdbcField } from "../src/odbc.js";
import { sqlServerOdbcAliasQuery } from "../src/odbc-aliases.js";
import type { OdbcColumn, OdbcCommand, OdbcReply } from "../src/odbc-protocol.js";
import { sqlServerCatalogQueries } from "../src/provider.js";
import { createSqlServerDatabase } from "../src/runtime.js";
import { defaultSqlServerTypePolicy } from "../src/type-policy.js";
import { directPortFixture } from "./helpers/direct-ports.js";
import { serverEvidence, serverRow } from "./helpers/environment.js";

const column = (name: string, typeName = "bigint", size = 19, type = -5, scale = 0): OdbcColumn => ({
  name,
  typeName,
  size,
  type,
  scale,
  nullable: false,
});
type AppHandler = (command: OdbcCommand) => Partial<OdbcReply>;
function fixture() {
  const state = directPortFixture();
  let nextHandle = 1,
    starts = 0;
  let aliasRows: readonly Record<string, string | number>[] = [];
  const id = column("id");
  let app: AppHandler = (command) => {
    if (command.kind === "prepare") return { handle: nextHandle++, result: { rows: [], columns: [id] } };
    if (command.kind === "streamStart") {
      starts++;
      return { handle: command.handle ?? nextHandle++, result: { rows: [], columns: [id] } };
    }
    if (command.kind === "streamNext") return { result: { rows: [["1"], ["2"], ["3"]], columns: [id] }, done: true };
    return { result: { rows: [["1"]], columns: [id] } };
  };
  state.data.handler = (value) => {
    const command = value as OdbcCommand;
    let reply: Partial<OdbcReply>;
    if ("text" in command && command.text === sqlServerCatalogQueries.server) {
      const names = Object.keys(serverRow);
      reply = {
        result: { columns: names.map((name) => column(name, "nvarchar", 128, -9)), rows: [Object.values(serverRow)] },
      };
    } else if ("text" in command && command.text === sqlServerOdbcAliasQuery) {
      const names = Object.keys(aliasRows[0] ?? {});
      reply = {
        result: {
          columns: names.map((name) => column(name, "nvarchar", 128, -9)),
          rows: aliasRows.map((row) => names.map((name) => String(row[name]))),
        },
      };
    } else if ("text" in command && command.text === sqlServerCatalogQueries.options)
      reply = {
        result: {
          columns: [column("Set Option", "nvarchar", 128, -9), column("Value", "nvarchar", 128, -9)],
          rows: [["dateformat", "mdy"]],
        },
      };
    else reply = app(command);
    queueMicrotask(() => state.data.emit("message", { id: command.id, ...reply }));
  };
  return {
    ...state,
    connection: createSqlServerOdbcConnection(state.transport),
    get aliasRows() {
      return aliasRows;
    },
    set aliasRows(rows: readonly Record<string, string | number>[]) {
      aliasRows = rows;
    },
    get app(): AppHandler {
      return app;
    },
    set app(value: AppHandler) {
      app = value;
    },
    get starts() {
      return starts;
    },
  };
}
const hash = calculateTypePolicyHash(defaultSqlServerTypePolicy);
const query = withQueryValuePlan(sql<{ id: bigint }>`SELECT ${1n} AS id`, {
  dialect: "sqlserver",
  typePolicyHash: hash,
  columns: [{ name: "id", databaseType: "bigint", type: "bigint", nullable: false }],
  parameters: [{ index: 1, databaseType: "bigint", type: "bigint", nullable: false }],
});
await describe("SQL Server direct adapter protocol composition", async () => {
  await it("rejects invalid runtime policies and capacities before loading drivers or acquiring credentials", async () => {
    let credentials = 0,
      imports = 0;
    const base = {
      connectionString: () => {
        credentials++;
        return "unused";
      },
      driverImporter: async () => {
        imports++;
        throw new Error("Must not load driver");
      },
    };
    for (const options of [
      { preparedStatementLimit: 0 },
      { preparedCardinalityVariantLimit: -1 },
      { maximumPreparedValueBytes: Infinity },
      { typePolicy: { ...defaultSqlServerTypePolicy, decimal: "Decimal" as const } },
    ])
      await strict.rejects(createSqlServerOdbcDatabase({ ...base, ...options }));
    strict.equal(credentials, 0);
    strict.equal(imports, 0);
  });
  await it("dispatches rowversion comparison bytes through the inferred binary target while rejecting oversize before SQL", async () => {
    const token = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1]);
    const analysis = sqlserver().analyze(
      "UPDATE dbo.versions SET id=id OUTPUT inserted.rv AS rv WHERE rv=@__typed_sql_1",
      {
        formatVersion: 1,
        dialect: "sqlserver",
        server: serverEvidence,
        tables: {
          versions: {
            schema: "dbo",
            name: "versions",
            columns: {
              id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
              rv: { name: "rv", databaseType: "rowversion", tsType: "Uint8Array", nullable: false },
            },
          },
        },
      },
    );
    strict.deepEqual(analysis.diagnostics, []);
    const query = (value: Uint8Array) =>
      withQueryValuePlan(
        sql<{ rv: Uint8Array }>`UPDATE dbo.versions SET id=id OUTPUT inserted.rv AS rv WHERE rv=${value}`,
        {
          dialect: "sqlserver",
          typePolicyHash: hash,
          columns: [{ name: "rv", databaseType: analysis.columns[0]!.databaseType!, type: "bytes", nullable: false }],
          parameters: [
            { index: 1, databaseType: analysis.parameters[0]!.databaseType!, type: "bytes", nullable: false },
          ],
        },
      );
    const state = fixture();
    state.app = (command) =>
      command.kind === "prepare"
        ? { handle: 1, result: { rows: [], columns: [column("rv", "timestamp", 8, -2)] } }
        : { result: { rows: [[token]], columns: [column("rv", "timestamp", 8, -2)] } };
    const db = createSqlServerDatabase({ connection: state.connection, serverEvidence });
    strict.deepEqual(await db.all(query(token)), [{ rv: token }]);
    const prepare = state.data.messages.find((message) => (message as OdbcCommand).kind === "prepare") as Extract<
      OdbcCommand,
      { kind: "prepare" }
    >;
    strict.ok(prepare.text.includes("CONVERT(binary(8), ?, 2)"));
    const execute = state.data.messages.find(
      (message) => (message as OdbcCommand).kind === "preparedExecute",
    ) as Extract<OdbcCommand, { kind: "preparedExecute" }>;
    strict.deepEqual(execute.values, ["0000000000000001"]);
    const before = state.data.messages.length;
    await strict.rejects(db.all(query(new Uint8Array(9))), /length/);
    strict.equal(state.data.messages.length, before);
    await db.close();
    await state.connection.close!();
  });
  await it("attests alias families on each idle physical lease and frees unsupported prepared metadata", async () => {
    const state = fixture();
    state.aliasRows = [
      { alias_schema: "dbo", alias_name: "catalog_alias", base_name: "bigint", max_length: 8, precision: 19, scale: 0 },
    ];
    state.app = (command) =>
      command.kind === "prepare"
        ? { handle: 1, result: { rows: [], columns: [column("id", "catalog_alias")] } }
        : { result: { rows: [["1"]], columns: [column("id", "catalog_alias")] } };
    const db = createSqlServerDatabase({ connection: state.connection, serverEvidence });
    strict.deepEqual(await db.all(query), [{ id: 1n }]);
    const original = state.data.handler;
    const cancellation = new AbortController();
    state.data.handler = (message) => {
      const command = message as OdbcCommand;
      if (command.kind === "execute" && command.text === sqlServerOdbcAliasQuery) cancellation.abort();
      original(message);
    };
    await strict.rejects(db.all(query, { signal: cancellation.signal }), /cancel/i);
    state.data.handler = original;
    strict.deepEqual(await db.all(query), [{ id: 1n }]);
    state.data.handler = (message) => {
      const command = message as OdbcCommand;
      if (command.kind === "execute" && command.text === sqlServerCatalogQueries.server)
        queueMicrotask(() =>
          state.data.emit("message", {
            id: command.id,
            error: { message: "metadata unavailable", stage: "execute", reusable: true },
          }),
        );
      else original(message);
    };
    await strict.rejects(state.connection.readServerEvidence!(), /metadata unavailable/);
    state.data.handler = original;
    await strict.rejects(state.connection.execute("SELECT raw alias"), /Unsupported/);
    state.aliasRows = [];
    await strict.rejects(db.all(query), /Unsupported/);
    strict.ok(state.data.messages.some((value) => (value as OdbcCommand).kind === "freePrepared"));
    state.transport.cursor = 42;
    await strict.rejects(state.connection.readServerEvidence!(), /idle/);
    state.transport.cursor = undefined;
    await db.close();
    await state.connection.close!();
  });
  await it("quarantines native preparation when rejected alias metadata cannot be freed", async () => {
    const state = fixture();
    state.app = (command) =>
      command.kind === "prepare"
        ? { handle: 1, result: { rows: [], columns: [column("id", "hidden_alias")] } }
        : command.kind === "freePrepared"
          ? { error: { message: "nativefreefailed", stage: "free-statement", reusable: false } }
          : {};
    const db = createSqlServerDatabase({ connection: state.connection, serverEvidence });
    await strict.rejects(db.all(query), /Unsupported/);
    strict.equal(state.transport.reusable, false);
    await strict.rejects(db.all(query), /quarantined/);
    await db.close();
    await state.connection.close!();
  });
  await it("normalizes exact identity type attributes only with matching independent numeric metadata", () => {
    for (const [name, code, size] of [
      ["bigint", -5, 19],
      ["int", 4, 10],
      ["smallint", 5, 5],
      ["tinyint", -6, 3],
      ["decimal", 3, 20],
      ["numeric", 2, 20],
    ] as const) {
      const field = sqlServerOdbcField(column("id", `${name} identity`, size, code));
      strict.equal(field.databaseType, ["decimal", "numeric"].includes(name) ? "decimal(20,0)" : name);
    }
    for (const input of [
      column("id", "bigint identity", 19, 12),
      column("id", "decimal identity", 20, 3, 2),
      column("id", "nvarchar identity", 40, -9),
      column("id", "bigint identity extra"),
      column("id", "bigint identity(1,1)"),
    ])
      strict.throws(() => sqlServerOdbcField(input));
  });
  await it("preserves native metadata families and describes the actual JSON wire facade", () => {
    for (const [input, type] of [
      [column("x", "decimal", 38, 3, 10), "decimal(38,10)"],
      [column("x", "nvarchar", 0, -9), "nvarchar(max)"],
      [column("x", "varchar", 8000, 12), "varchar(8000)"],
      [column("x", "datetime2", 27, 93, 7), "datetime2(7)"],
      [column("x", "datetimeoffset", 34, -155, 7), "datetimeoffset(7)"],
      [column("x", "timestamp", 8, -2), "rowversion"],
      [column("x", "float", 15, 8), "float(53)"],
      [column("x", "xml", 0, -152), "xml"],
      [column("x", "uniqueidentifier", 36, -11), "uniqueidentifier"],
    ] as const)
      strict.equal(sqlServerOdbcField(input).databaseType, type);
    const json = sqlServerOdbcField(column("x", "varchar", 0, 12));
    strict.equal(json.databaseType, "varchar(max)");
    strict.equal(json.wireType, "odbc-varchar-unlimited-text");
    strict.throws(() => sqlServerOdbcField(column("x", "unqualified_udt")), /Unsupported/);
  });
  await it("encodes exact raw values and rejects bad or over-budget inputs before dispatch", async () => {
    const state = fixture();
    await state.transport.ready;
    await state.connection.execute("SELECT values", [null, "x\0", true, 1.25, 42n, Uint8Array.of(0, 255)]);
    const command = state.data.messages[0] as Extract<OdbcCommand, { kind: "execute" }>;
    strict.deepEqual(command.values, [null, "x\0", "1", "1.25", "42", Uint8Array.of(0, 255)]);
    const before = state.data.messages.length;
    for (const value of [undefined, {}, Infinity, Number.MAX_SAFE_INTEGER + 1, new Uint8Array(2048)])
      await strict.rejects(() => state.connection.execute("SELECT invalid", [value]));
    strict.equal(state.data.messages.length, before);
    await state.connection.close!();
  });
  await it("validates available streamed DML metadata before starting its native mutation", async () => {
    const state = fixture();
    state.app = (command) =>
      command.kind === "prepare"
        ? { handle: 4, result: { rows: [], columns: [column("id", "int", 10, 4)] } }
        : { result: { rows: [], columns: [] } };
    const db = createSqlServerDatabase({ connection: state.connection, serverEvidence });
    const mutation = withQueryValuePlan(sql<{ id: bigint }>`DELETE FROM dbo.messages OUTPUT deleted.id`, {
      dialect: "sqlserver",
      typePolicyHash: hash,
      columns: [{ name: "id", databaseType: "bigint", type: "bigint", nullable: false }],
      parameters: [],
    });
    await strict.rejects(() => db.stream(mutation).next(), /native result type/);
    strict.equal(
      state.data.messages.some((value) => (value as OdbcCommand).kind === "streamStart"),
      false,
    );
    strict.equal(
      state.data.messages.some((value) => (value as OdbcCommand).kind === "streamClose"),
      true,
    );
    strict.equal(state.transport.cursor, undefined);
    await db.close();
  });
  await it("retains every final batch row and closes typed native cursors once", async () => {
    const state = fixture(),
      db = createSqlServerDatabase({ connection: state.connection, serverEvidence });
    const stream = db.stream(query, { batchSize: 100 }),
      rows: bigint[] = [];
    for await (const row of stream) rows.push(row.id);
    strict.deepEqual(rows, [1n, 2n, 3n]);
    strict.equal(state.starts, 1);
    strict.equal(state.data.messages.filter((value) => (value as OdbcCommand).kind === "streamClose").length, 1);
    await stream.close();
    await db.close();
  });
  await it("prepares, reuses, retires and frees public logical prepared handles", async () => {
    const state = fixture(),
      db = createSqlServerDatabase({ connection: state.connection, serverEvidence });
    const prepared = db.prepare("select-id", () => query);
    strict.deepEqual(await db.one(prepared()), { id: 1n });
    strict.deepEqual(await db.one(prepared()), { id: 1n });
    strict.equal(state.data.messages.filter((value) => (value as OdbcCommand).kind === "prepare").length, 1);
    await db.unprepare("select-id");
    strict.equal(state.data.messages.filter((value) => (value as OdbcCommand).kind === "freePrepared").length, 1);
    await strict.rejects(() => db.all(prepared()), /retired/);
    await db.close();
  });
});
