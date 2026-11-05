import { EventEmitter } from "node:events";
import { type OdbcCommand, type OdbcWorkerOptions, odbcState, ODBC_STATE as S } from "../../src/odbc-protocol.js";
import { type OdbcWorkerFactory, SqlServerOdbcTransport } from "../../src/odbc-transport.js";
export class Port extends EventEmitter {
  readonly messages: unknown[] = [];
  unrefs = 0;
  handler: (value: unknown) => void = () => {};
  constructor(readonly ready = true) {
    super();
    queueMicrotask(() => this.emit("message", { ready }));
  }
  postMessage(value: unknown) {
    this.messages.push(value);
    this.handler(value);
  }
  unref() {
    this.unrefs++;
  }
}
export function directPortFixture(ready = true) {
  const options: OdbcWorkerOptions = {
    modulePath: "unused",
    libraryPath: "unused",
    connectionString: "unused",
    shared: new SharedArrayBuffer(48),
    loginTimeoutSeconds: 15,
    queryTimeoutSeconds: 30,
    maximumCellBytes: 1024,
    maximumResultBytes: 1024,
    maximumRows: 100,
    chunkBytes: 6,
  };
  const data = new Port(ready),
    control = new Port(),
    { words } = odbcState(options.shared);
  data.handler = (value) => {
    const command = value as OdbcCommand;
    queueMicrotask(() => data.emit("message", { id: command.id, result: { rows: [], columns: [] } }));
  };
  control.handler = (value) => {
    const message = value as { kind: string; epoch?: number };
    if (message.kind === "cancel") {
      Atomics.store(words, S.ack, message.epoch!);
      queueMicrotask(() => control.emit("message", { ack: message.epoch }));
    }
  };
  const factory: OdbcWorkerFactory = (_url, role) => (role === "data" ? data : control);
  return { transport: new SqlServerOdbcTransport(options, factory), data, control, words };
}
