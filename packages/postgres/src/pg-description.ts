import type { PgLiveVerifierClient } from "./pg.js";

export interface PgProtocolField {
  readonly name: string;
  readonly dataTypeID: number;
  readonly dataTypeModifier?: number;
}

export interface PgProtocolDescription {
  readonly parameters: readonly number[];
  readonly columns: readonly PgProtocolField[];
}

interface PgProtocolConnection {
  parse(request: { readonly text: string; readonly name: string; readonly types: readonly number[] }): void;
  describe(request: { readonly type: "S"; readonly name: string }): void;
  sync(): void;
  on(event: "parameterDescription", listener: (message: { readonly dataTypeIDs: readonly number[] }) => void): void;
  off(event: "parameterDescription", listener: (message: { readonly dataTypeIDs: readonly number[] }) => void): void;
}

interface PgProtocolClient extends PgLiveVerifierClient {
  readonly connection?: PgProtocolConnection;
}

export function describePgStatement(
  client: PgLiveVerifierClient,
  name: string,
  sql: string,
): Promise<PgProtocolDescription> | undefined {
  const protocolClient = client as PgProtocolClient;
  if (protocolClient.connection === undefined) return undefined;
  return new Promise((resolve, reject) => {
    let parameters: readonly number[] = [];
    let columns: readonly PgProtocolField[] = [];
    let connection: PgProtocolConnection | undefined;
    let settled = false;
    const parameterDescription = (message: { readonly dataTypeIDs: readonly number[] }): void => {
      parameters = [...message.dataTypeIDs];
    };
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      connection?.off("parameterDescription", parameterDescription);
      if (error === undefined) resolve({ parameters, columns });
      else reject(error);
    };
    const query = {
      // The statement name belongs only to protocol messages. Supplying Query.name/text here
      // makes pg retain application SQL in its parsedStatements cache even after DEALLOCATE.
      callback: undefined as ((error?: unknown) => void) | undefined,
      submit(value: PgProtocolConnection) {
        connection = value;
        value.on("parameterDescription", parameterDescription);
        value.parse({ text: sql, name, types: [] });
        value.describe({ type: "S", name });
        value.sync();
      },
      handleRowDescription(message: { readonly fields: readonly PgProtocolField[] }) {
        columns = message.fields.map(({ name: fieldName, dataTypeID, dataTypeModifier }) => ({
          name: fieldName,
          dataTypeID,
          ...(dataTypeModifier === undefined ? {} : { dataTypeModifier }),
        }));
      },
      handleError(error: unknown) {
        finish(error);
      },
      handleReadyForQuery() {
        finish();
      },
    };
    type CustomQueryClient = {
      query(value: typeof query, callback: (error?: unknown) => void): void;
    };
    (client as unknown as CustomQueryClient).query(query, (error) => {
      if (error !== undefined) finish(error);
    });
  });
}
