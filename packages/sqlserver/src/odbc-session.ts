import { type OdbcNative, OdbcNativeError } from "./odbc-native.js";
import {
  type OdbcColumn,
  type OdbcCommand,
  type OdbcReply,
  type OdbcResult,
  type OdbcValue,
  ODBC_STATE as S,
} from "./odbc-protocol.js";

interface Statement {
  readonly handle: bigint;
  readonly allocations: unknown[];
  columns: readonly OdbcColumn[];
  readonly prepared: boolean;
  rows: number;
  bytes: number;
  finished: boolean;
}
/** Confined to the data worker. Native handles and retained parameter memory never escape it. */
export class OdbcSession {
  env = 0n;
  connection = 0n;
  connected = false;
  closed = false;
  readonly statements = new Map<number, Statement>();
  readonly owned = new Set<Statement>();
  nextHandle = 1;
  constructor(readonly native: OdbcNative) {}
  open(): void {
    const n = this.native;
    try {
      this.env = n.allocate(1, 0n);
      n.check(n.api.SQLSetEnvAttr!(this.env, 200, 3n, 0), "ODBC-version", 1, this.env);
      this.connection = n.allocate(2, this.env);
      n.check(
        n.api.SQLSetConnectAttrW!(this.connection, 103, BigInt(n.options.loginTimeoutSeconds), 0),
        "login-timeout",
        2,
        this.connection,
      );
      const text = n.options.connectionString;
      if (!text || text.length > 32767 || text.includes("\0")) throw new OdbcNativeError("connection-string-bound");
      const rc = n.api.SQLDriverConnectW!(this.connection, 0n, n.wide(text), text.length, null, 0, [0], 0);
      this.connected = rc === 0 || rc === 1;
      n.check(rc, "connect", 2, this.connection, [5701, 5703]);
    } catch (error) {
      try {
        this.close();
      } catch {}
      throw error;
    }
  }
  create(prepared: boolean): Statement {
    const n = this.native,
      handle = n.allocate(3, this.connection);
    const statement: Statement = { handle, allocations: [], columns: [], prepared, rows: 0, bytes: 0, finished: false };
    this.owned.add(statement);
    try {
      n.check(n.api.SQLSetStmtAttrW!(handle, 0, BigInt(n.options.queryTimeoutSeconds), 0), "query-timeout", 3, handle);
      return statement;
    } catch (error) {
      this.destroy(statement);
      throw error;
    }
  }
  destroy(statement: Statement): void {
    if (
      Atomics.load(this.native.state.words, S.borrows) !== 0 ||
      Atomics.load(this.native.state.words, S.controlFailure)
    ) {
      this.native.reusable = false;
      throw new OdbcNativeError("unsettled-native-borrow", [], false);
    }
    const rc = this.native.api.SQLFreeHandle!(3, statement.handle);
    if (rc !== 0) {
      this.native.reusable = false;
      this.native.check(rc, "free-statement", 3, statement.handle);
    }
    for (const pointer of statement.allocations.splice(0)) this.native.koffi.free(pointer);
    this.owned.delete(statement);
  }
  reset(statement: Statement): void {
    const n = this.native;
    n.invoke("SQLFreeStmt", statement.handle, "close-cursor", statement.handle, 0);
    n.invoke("SQLFreeStmt", statement.handle, "reset-parameters", statement.handle, 3);
    for (const pointer of statement.allocations.splice(0)) n.koffi.free(pointer);
    statement.rows = 0;
    statement.bytes = 0;
    statement.finished = false;
    statement.columns = [];
  }
  prepare(text: string): { statement: Statement; columns?: readonly OdbcColumn[] } {
    const statement = this.create(true),
      n = this.native;
    try {
      n.invoke("SQLPrepareW", statement.handle, "prepare", statement.handle, n.wide(text), text.length);
      let columns: readonly OdbcColumn[] | undefined;
      try {
        const described = n.columns(statement.handle);
        if (described.length) columns = described;
      } catch (error) {
        if (
          !(error instanceof OdbcNativeError) ||
          !error.diagnostics.length ||
          error.diagnostics.some((record) => !["HY010", "HYC00"].includes(record.state))
        )
          throw error;
      }
      return { statement, ...(columns ? { columns } : {}) };
    } catch (error) {
      this.destroy(statement);
      throw error;
    }
  }
  firstResult(statement: Statement): void {
    const n = this.native;
    for (let stage = 0; stage < 128; stage++) {
      statement.columns = n.columns(statement.handle);
      if (statement.columns.length) return;
      const rc = n.call("SQLMoreResults", statement.handle, statement.handle);
      n.assertActive();
      if (rc === 100) {
        statement.finished = true;
        return;
      }
      n.check(rc, "more-results", 3, statement.handle, [5701, 5703, 8153]);
    }
    throw new OdbcNativeError("result-stage-limit");
  }
  finish(statement: Statement): void {
    const n = this.native;
    for (let stage = 0; stage < 128; stage++) {
      const rc = n.call("SQLMoreResults", statement.handle, statement.handle);
      n.assertActive();
      if (rc === 100) {
        statement.finished = true;
        return;
      }
      n.check(rc, "more-results", 3, statement.handle, [5701, 5703, 8153]);
      if (n.columns(statement.handle).length) throw new OdbcNativeError("multiple-result-sets");
    }
    throw new OdbcNativeError("result-stage-limit");
  }
  start(text: string, values: readonly OdbcValue[], existing?: Statement): Statement {
    const n = this.native,
      statement = existing ?? this.create(false);
    try {
      if (existing) this.reset(statement);
      if (existing || values.length) {
        if (!existing)
          n.invoke("SQLPrepareW", statement.handle, "prepare", statement.handle, n.wide(text), text.length);
        n.bind(statement.handle, values, statement.allocations);
        n.invoke("SQLExecute", statement.handle, "execute", statement.handle);
      } else n.invoke("SQLExecDirectW", statement.handle, "execute", statement.handle, n.wide(text), text.length);
      this.firstResult(statement);
      return statement;
    } catch (error) {
      if (!existing) this.destroy(statement);
      throw error;
    }
  }
  fetch(statement: Statement, batchSize: number): OdbcResult & { done: boolean } {
    const rows: OdbcValue[][] = [],
      n = this.native;
    let batchBytes = 0;
    while (!statement.finished && rows.length < batchSize) {
      const rc = n.call("SQLFetch", statement.handle, statement.handle);
      n.assertActive();
      if (rc === 100) {
        this.finish(statement);
        break;
      }
      n.check(rc, "fetch", 3, statement.handle, [5701, 5703, 8153]);
      const row = statement.columns.map((column, index) =>
        n.cell(statement.handle, index + 1, [-2, -3, -4].includes(column.type)),
      );
      const bytes = row.reduce(
        (sum, value) => sum + (typeof value === "string" ? value.length * 2 : (value?.byteLength ?? 0)),
        0,
      );
      batchBytes += bytes;
      statement.bytes += bytes;
      statement.rows++;
      if (statement.rows > n.options.maximumRows || batchBytes > n.options.maximumResultBytes)
        throw new OdbcNativeError("result-memory-bound");
      rows.push(row);
    }
    return { rows, columns: statement.columns, done: statement.finished };
  }
  command(command: OdbcCommand): OdbcReply {
    if (this.closed || (!this.native.reusable && !["close", "freePrepared", "streamClose"].includes(command.kind)))
      throw new OdbcNativeError("connection-quarantined", [], false);
    this.native.epoch = command.id;
    try {
      switch (command.kind) {
        case "prepare": {
          const { statement, columns } = this.prepare(command.text),
            handle = this.nextHandle++;
          this.statements.set(handle, statement);
          return { id: command.id, handle, ...(columns ? { result: { rows: [], columns } } : {}) };
        }
        case "freePrepared":
        case "streamClose": {
          const statement = this.statements.get(command.handle);
          if (statement) {
            this.destroy(statement);
            this.statements.delete(command.handle);
          }
          return { id: command.id };
        }
        case "execute":
        case "preparedExecute":
        case "streamStart": {
          const existing = command.kind === "preparedExecute" ? this.statements.get(command.handle) : undefined;
          if (command.kind === "preparedExecute" && !existing) throw new OdbcNativeError("unknown-prepared-handle");
          let statement: Statement | undefined;
          try {
            statement = this.start("text" in command ? command.text : "", command.values, existing);
            if (command.kind === "streamStart") {
              const handle = this.nextHandle++;
              this.statements.set(handle, statement);
              return { id: command.id, handle, result: { rows: [], columns: statement.columns } };
            }
            const result = this.fetch(statement, this.native.options.maximumRows + 1);
            if (
              result.rows.reduce(
                (bytes, row) =>
                  bytes +
                  row.reduce(
                    (sum, value) => sum + (typeof value === "string" ? value.length * 2 : (value?.byteLength ?? 0)),
                    0,
                  ),
                0,
              ) > this.native.options.maximumResultBytes
            )
              throw new OdbcNativeError("result-memory-bound");
            return { id: command.id, result };
          } finally {
            if (statement && command.kind !== "streamStart" && !existing) this.destroy(statement);
          }
        }
        case "streamNext": {
          const statement = this.statements.get(command.handle);
          if (!statement) throw new OdbcNativeError("unknown-stream-handle");
          const result = this.fetch(statement, command.batchSize);
          return { id: command.id, result: { rows: result.rows, columns: result.columns }, done: result.done };
        }
        case "close":
          this.close();
          return { id: command.id };
      }
    } finally {
      this.native.epoch = 0;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const n = this.native;
    if (Atomics.load(n.state.words, S.borrows) !== 0 || Atomics.load(n.state.words, S.controlFailure)) {
      n.reusable = false;
      throw new OdbcNativeError("unsettled-native-borrow", [], false);
    }
    let failure: unknown;
    for (const statement of this.owned)
      try {
        this.destroy(statement);
      } catch (error) {
        failure ??= error;
      }
    if (failure) throw failure;
    this.statements.clear();
    if (this.connected) {
      const rc = n.api.SQLDisconnect!(this.connection);
      n.check(rc, "disconnect", 2, this.connection);
      this.connected = false;
    }
    if (this.connection) {
      const handle = this.connection,
        rc = n.api.SQLFreeHandle!(2, handle);
      n.check(rc, "free-connection", 2, handle);
      this.connection = 0n;
    }
    if (this.env) {
      const handle = this.env,
        rc = n.api.SQLFreeHandle!(1, handle);
      n.check(rc, "free-environment", 1, handle);
      this.env = 0n;
    }
  }
}
