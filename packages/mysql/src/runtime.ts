import { type Database, type Query, renderQuery, type SqlRenderer } from "@typed-sql/core";
import { defaultMySqlTypePolicy, type MySqlTypePolicy } from "./type-policy.js";

export interface MySqlFieldLike {
  readonly name: string;
  readonly columnType: number;
  readonly columnLength?: number;
}

export interface MySqlExecutionResult {
  readonly rows: readonly Record<string, unknown>[] | Record<string, unknown>;
  readonly fields?: readonly MySqlFieldLike[];
}

export interface MySqlConnectionLike {
  execute(sql: string, values?: readonly unknown[]): Promise<MySqlExecutionResult>;
  query(sql: string): Promise<MySqlExecutionResult>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface MySqlPoolLike {
  execute(sql: string, values?: readonly unknown[]): Promise<MySqlExecutionResult>;
  getConnection(): Promise<MySqlConnectionLike>;
  end(): Promise<void>;
}

export interface MySqlDatabase extends Database {
  close(): Promise<void>;
}

export interface MySqlDatabaseOptions {
  readonly pool: MySqlPoolLike;
  readonly ownsPool?: boolean;
  readonly typePolicy?: Pick<MySqlTypePolicy, "bigint" | "decimal" | "date" | "json" | "tinyint1">;
  readonly decimal?: (value: string) => unknown;
}

type ResolvedMySqlRuntimeTypePolicy = Pick<MySqlTypePolicy, "bigint" | "decimal" | "date" | "json" | "tinyint1">;

type ValueDecoder = (value: unknown) => unknown;

interface ColumnDecoder {
  readonly name: string;
  readonly decode: ValueDecoder;
}

const defaultRuntimeTypePolicy: ResolvedMySqlRuntimeTypePolicy = defaultMySqlTypePolicy;

const mysqlTypes = { tiny: 1, longlong: 8, date: 10, datetime: 12, timestamp: 7, json: 245, decimal: 246 } as const;

export const mysqlRenderer: SqlRenderer = Object.freeze({
  placeholder: () => "?",
  quoteIdentifier: (identifier: string) => `\`${identifier.replaceAll("`", "``")}\``,
});

function encoded(value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(encoded) : value;
}

function finite(value: string, label: string): number {
  const result = Number(value);
  if (!Number.isFinite(result))
    throw new RangeError(`${label} value ${value} cannot be represented as a finite number`);
  return result;
}

function nullable(decoder: ValueDecoder): ValueDecoder {
  return (value) => (value === null || value === undefined ? value : decoder(value));
}

function compileValueDecoder(
  field: MySqlFieldLike,
  typePolicy: ResolvedMySqlRuntimeTypePolicy,
  decimal?: (value: string) => unknown,
): ValueDecoder | undefined {
  if (field.columnType === mysqlTypes.longlong) {
    if (typePolicy.bigint === "bigint") return nullable((value) => BigInt(String(value)));
    if (typePolicy.bigint === "number")
      return nullable((value) => {
        const result = finite(String(value), "bigint");
        if (!Number.isSafeInteger(result))
          throw new RangeError(`bigint value ${value} exceeds JavaScript's safe integer range`);
        return result;
      });
    return nullable((value) => String(value));
  }
  if (field.columnType === mysqlTypes.decimal) {
    if (typePolicy.decimal === "number") return nullable((value) => finite(String(value), "decimal"));
    if (typePolicy.decimal === "Decimal") {
      if (decimal === undefined) throw new TypeError("decimal=Decimal requires a decimal(value) codec");
      return nullable((value) => decimal(String(value)));
    }
    return nullable((value) => String(value));
  }
  if (
    field.columnType === mysqlTypes.date ||
    field.columnType === mysqlTypes.datetime ||
    field.columnType === mysqlTypes.timestamp
  ) {
    return typePolicy.date === "string"
      ? nullable((value) => String(value))
      : nullable((value) => (value instanceof Date ? value : new Date(String(value))));
  }
  if (field.columnType === mysqlTypes.json && typePolicy.json === "string")
    return nullable((value) => (typeof value === "string" ? value : JSON.stringify(value)));
  if (field.columnType === mysqlTypes.tiny && field.columnLength === 1 && typePolicy.tinyint1 === "boolean")
    return nullable((value) => value === true || value === 1 || value === "1");
  return undefined;
}

function compileRowDecoders(
  fields: readonly MySqlFieldLike[],
  typePolicy: ResolvedMySqlRuntimeTypePolicy,
  decimal?: (value: string) => unknown,
): readonly ColumnDecoder[] {
  const decoders: ColumnDecoder[] = [];
  const visited = new Set<string>();
  for (const field of fields) {
    // Preserve established behavior: the first metadata entry for a row property owns its decoding.
    if (visited.has(field.name)) continue;
    visited.add(field.name);
    const decode = compileValueDecoder(field, typePolicy, decimal);
    if (decode !== undefined) decoders.push({ name: field.name, decode });
  }
  return decoders;
}

function decodeRows(
  rows: readonly Record<string, unknown>[],
  decoders: readonly ColumnDecoder[],
): readonly Record<string, unknown>[] {
  if (decoders.length === 0) return rows;
  // Keep driver objects intact until a codec produces a different value for that specific row.
  let decodedRows: Record<string, unknown>[] | undefined;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    let decodedRow: Record<string, unknown> | undefined;
    for (const column of decoders) {
      if (!Object.prototype.propertyIsEnumerable.call(row, column.name)) continue;
      const value = row[column.name];
      const decoded = column.decode(value);
      if (Object.is(decoded, value)) continue;
      decodedRow ??= { ...row };
      decodedRow[column.name] = decoded;
    }
    if (decodedRow === undefined) continue;
    decodedRows ??= rows.slice() as Record<string, unknown>[];
    decodedRows[rowIndex] = decodedRow;
  }
  return decodedRows ?? rows;
}

class MySqlDatabaseImplementation implements MySqlDatabase {
  readonly #pool: MySqlPoolLike;
  readonly #connection: MySqlConnectionLike | undefined;
  readonly #ownsPool: boolean;
  readonly #typePolicy: ResolvedMySqlRuntimeTypePolicy;
  readonly #decimal: ((value: string) => unknown) | undefined;
  readonly #depth: number;

  constructor(
    pool: MySqlPoolLike,
    connection: MySqlConnectionLike | undefined,
    ownsPool: boolean,
    typePolicy: ResolvedMySqlRuntimeTypePolicy,
    decimal: ((value: string) => unknown) | undefined,
    depth: number,
  ) {
    this.#pool = pool;
    this.#connection = connection;
    this.#ownsPool = ownsPool;
    this.#typePolicy = typePolicy;
    this.#decimal = decimal;
    this.#depth = depth;
  }

  async execute<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): Promise<readonly Row[]> {
    const rendered = renderQuery(query, mysqlRenderer);
    const result = await (this.#connection ?? this.#pool).execute(rendered.text, rendered.values.map(encoded));
    if (!Array.isArray(result.rows)) return [];
    const decoders = compileRowDecoders(result.fields ?? [], this.#typePolicy, this.#decimal);
    return decodeRows(result.rows, decoders) as unknown as readonly Row[];
  }

  async transaction<T>(fn: (database: Database) => Promise<T>): Promise<T> {
    if (this.#connection !== undefined) return this.#nested(fn);
    const connection = await this.#pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await fn(
        new MySqlDatabaseImplementation(this.#pool, connection, false, this.#typePolicy, this.#decimal, 1),
      );
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        /* Preserve the original failure. */
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async #nested<T>(fn: (database: Database) => Promise<T>): Promise<T> {
    const connection = this.#connection!;
    const depth = this.#depth + 1;
    const savepoint = `typed_sql_${depth}`;
    await connection.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await fn(
        new MySqlDatabaseImplementation(this.#pool, connection, false, this.#typePolicy, this.#decimal, depth),
      );
      await connection.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#connection !== undefined) throw new Error("Cannot close a database from inside a transaction");
    if (this.#ownsPool) await this.#pool.end();
  }
}

export function createMySqlDatabase(options: MySqlDatabaseOptions): MySqlDatabase {
  const typePolicy: ResolvedMySqlRuntimeTypePolicy = { ...defaultRuntimeTypePolicy, ...options.typePolicy };
  if (typePolicy.decimal === "Decimal" && options.decimal === undefined)
    throw new TypeError("decimal=Decimal requires a decimal(value) codec");
  return new MySqlDatabaseImplementation(
    options.pool,
    undefined,
    options.ownsPool ?? false,
    typePolicy,
    options.decimal,
    0,
  );
}
