import { sql, withQueryValuePlan } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import { createSqlServerOdbcConnection, sqlServerOdbcField } from "../src/odbc.js";
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
