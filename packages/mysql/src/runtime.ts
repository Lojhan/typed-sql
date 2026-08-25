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

const defaultRuntimePolicy = defaultMySqlTypePolicy;

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

function decode(
  value: unknown,
  field: MySqlFieldLike,
  policy: MySqlDatabaseOptions["typePolicy"] & {},
  decimal?: (value: string) => unknown,
): unknown {
  if (value === null || value === undefined) return value;
  if (field.columnType === mysqlTypes.longlong) {
    if (policy.bigint === "bigint") return BigInt(String(value));
    if (policy.bigint === "number") {
      const result = finite(String(value), "bigint");
      if (!Number.isSafeInteger(result))
        throw new RangeError(`bigint value ${value} exceeds JavaScript's safe integer range`);
      return result;
    }
    return String(value);
  }
  if (field.columnType === mysqlTypes.decimal) {
    if (policy.decimal === "number") return finite(String(value), "decimal");
    if (policy.decimal === "Decimal") {
      if (decimal === undefined) throw new TypeError("decimal=Decimal requires a decimal(value) codec");
      return decimal(String(value));
    }
    return String(value);
  }
  if ([mysqlTypes.date, mysqlTypes.datetime, mysqlTypes.timestamp].includes(field.columnType as 7 | 10 | 12)) {
    return policy.date === "string" ? String(value) : value instanceof Date ? value : new Date(String(value));
  }
  if (field.columnType === mysqlTypes.json && policy.json === "string")
    return typeof value === "string" ? value : JSON.stringify(value);
  if (field.columnType === mysqlTypes.tiny && field.columnLength === 1 && policy.tinyint1 === "boolean")
    return value === true || value === 1 || value === "1";
  return value;
}

class MySqlDatabaseImplementation implements MySqlDatabase {
  readonly #pool: MySqlPoolLike;
  readonly #connection: MySqlConnectionLike | undefined;
  readonly #ownsPool: boolean;
  readonly #policy: NonNullable<MySqlDatabaseOptions["typePolicy"]>;
  readonly #decimal: ((value: string) => unknown) | undefined;
  readonly #depth: number;

  constructor(
    pool: MySqlPoolLike,
    connection: MySqlConnectionLike | undefined,
    ownsPool: boolean,
    policy: NonNullable<MySqlDatabaseOptions["typePolicy"]>,
    decimal: ((value: string) => unknown) | undefined,
    depth: number,
  ) {
    this.#pool = pool;
    this.#connection = connection;
    this.#ownsPool = ownsPool;
    this.#policy = policy;
    this.#decimal = decimal;
    this.#depth = depth;
  }

  async execute<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): Promise<readonly Row[]> {
    const rendered = renderQuery(query, mysqlRenderer);
    const result = await (this.#connection ?? this.#pool).execute(rendered.text, rendered.values.map(encoded));
    if (!Array.isArray(result.rows)) return [];
    const fields = result.fields ?? [];
    return result.rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => {
          const field = fields.find((candidate) => candidate.name === key);
          return [key, field === undefined ? value : decode(value, field, this.#policy, this.#decimal)];
        }),
      ),
    ) as unknown as readonly Row[];
  }

  async transaction<T>(fn: (database: Database) => Promise<T>): Promise<T> {
    if (this.#connection !== undefined) return this.#nested(fn);
    const connection = await this.#pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await fn(
        new MySqlDatabaseImplementation(this.#pool, connection, false, this.#policy, this.#decimal, 1),
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
        new MySqlDatabaseImplementation(this.#pool, connection, false, this.#policy, this.#decimal, depth),
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
  const policy = { ...defaultRuntimePolicy, ...options.typePolicy };
  if (policy.decimal === "Decimal" && options.decimal === undefined)
    throw new TypeError("decimal=Decimal requires a decimal(value) codec");
  return new MySqlDatabaseImplementation(
    options.pool,
    undefined,
    options.ownsPool ?? false,
    policy,
    options.decimal,
    0,
  );
}
