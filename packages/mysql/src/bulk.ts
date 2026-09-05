import {
  defineAdapterCapability,
  type ExecutionOptions,
  executeBulkRows,
  type Query,
  type SqlRenderer,
} from "@typed-sql/core";
import { parseStatement } from "./parser/index.js";

const mysqlRenderer: SqlRenderer = Object.freeze({
  placeholder: () => "?",
  quoteIdentifier: (name: string) => `\`${name.replaceAll("`", "``")}\``,
});

export interface MySqlBulkProgress {
  readonly rows: number;
  readonly bytes: number;
}

export interface MySqlBulkResult extends MySqlBulkProgress {}

export interface MySqlLoadDataOptions extends ExecutionOptions {
  /** Preferred encoded chunk size. One unusually wide row may exceed it. */
  readonly chunkBytes?: number;
  readonly onProgress?: (progress: MySqlBulkProgress) => void;
}

export interface MySqlBulkTransport {
  loadData(statement: string, chunks: AsyncIterable<Uint8Array>, options: ExecutionOptions): Promise<void>;
}

export interface MySqlBulkCapability {
  /** Compiles one typed INSERT factory into a client-streamed LOAD DATA LOCAL INFILE operation. */
  loadData<Input, Row, Params extends readonly unknown[]>(
    rowQuery: (input: Input) => Query<Row, Params>,
    rows: Iterable<Input> | AsyncIterable<Input>,
    options?: MySqlLoadDataOptions,
  ): Promise<MySqlBulkResult>;
}

export const mysqlBulk = defineAdapterCapability<MySqlBulkCapability>("mysql.load-data");

const encoder = new TextEncoder();
const DEFAULT_CHUNK_BYTES = 64 * 1_024;

function mysqlTextValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("MySQL LOAD DATA cannot encode non-finite numbers");
    return String(value);
  }
  if (value instanceof Date) {
    throw new TypeError(
      "MySQL LOAD DATA text mode does not accept Date values because mysql2 timezone encoding is connection-specific; use ordinary execution",
    );
  }
  if (value instanceof Uint8Array) {
    throw new TypeError("MySQL LOAD DATA text mode does not accept binary values; use ordinary execution");
  }
  if (typeof value === "object" && value !== null) {
    throw new TypeError(
      "MySQL LOAD DATA text mode does not accept structured values because mysql2 parameter encoding is type-specific; use ordinary execution",
    );
  }
  throw new TypeError(`MySQL LOAD DATA cannot encode ${typeof value} values`);
}

function escapedField(value: unknown): string {
  if (value === null || value === undefined) return "\\N";
  return mysqlTextValue(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\0", "\\0")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

function encodedRow(values: readonly unknown[]): Uint8Array {
  return encoder.encode(`${values.map(escapedField).join("\t")}\n`);
}

function chunkSize(value: number | undefined): number {
  const resolved = value ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError("MySQL LOAD DATA chunkBytes must be a positive safe integer");
  }
  return resolved;
}

function loadDataStatement(text: string, parameterCount: number): string {
  const statement = parseStatement(text);
  if (
    statement.kind !== "insert" ||
    statement.operation !== "insert" ||
    statement.with !== undefined ||
    statement.priority !== undefined ||
    statement.ignore ||
    statement.table.alias !== undefined ||
    (statement.table.partitions?.length ?? 0) > 0 ||
    statement.source.kind !== "values" ||
    statement.source.rows.length !== 1 ||
    statement.returning.length !== 0 ||
    statement.rowAlias !== undefined ||
    statement.duplicateKey.length > 0 ||
    statement.columns.length === 0
  ) {
    throw new TypeError(
      "MySQL LOAD DATA requires a plain single-row INSERT with an explicit column list and one VALUES row",
    );
  }
  const values = statement.source.rows[0]!;
  if (
    values.length !== statement.columns.length ||
    values.length !== parameterCount ||
    values.some((expression, index) => expression.kind !== "parameter" || expression.index !== index + 1)
  ) {
    throw new TypeError("MySQL LOAD DATA INSERT values must be one ordered parameter per target column");
  }
  const quote = mysqlRenderer.quoteIdentifier;
  const table = `${statement.table.schema === undefined ? "" : `${quote(statement.table.schema.name)}.`}${quote(statement.table.name.name)}`;
  const columns = statement.columns.map(({ name }) => quote(name)).join(", ");
  return `LOAD DATA LOCAL INFILE 'typed-sql-stream' INTO TABLE ${table} CHARACTER SET utf8mb4 FIELDS TERMINATED BY X'09' ESCAPED BY X'5C' LINES TERMINATED BY X'0A' (${columns})`;
}

export function createMySqlBulkCapability(transport: MySqlBulkTransport): MySqlBulkCapability {
  return Object.freeze({
    async loadData<Input, Row, Params extends readonly unknown[]>(
      rowQuery: (input: Input) => Query<Row, Params>,
      rows: Iterable<Input> | AsyncIterable<Input>,
      options: MySqlLoadDataOptions = {},
    ): Promise<MySqlBulkResult> {
      return executeBulkRows(rowQuery, rows, options, {
        renderer: mysqlRenderer,
        chunkBytes: chunkSize(options.chunkBytes),
        shapeError: "MySQL LOAD DATA row query changed its structural SQL shape",
        statement: loadDataStatement,
        encodeRow: encodedRow,
        transfer: (statement, chunks, options) => transport.loadData(statement, chunks, options),
      });
    },
  });
}
