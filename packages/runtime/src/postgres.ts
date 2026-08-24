import { Pool, types, type PoolClient, type PoolConfig, type QueryConfig } from "pg";
import type { Database, Query } from "./index.js";

export interface PostgresCodecPolicy {
  readonly bigint: "bigint" | "string" | "number";
  readonly numeric: "string" | "number" | "Decimal";
  readonly date: "Date" | "string";
  readonly json: "unknown" | "JsonValue" | "string";
}

export interface PostgresQueryConfig {
  readonly text: string;
  readonly values?: readonly unknown[];
  readonly types?: ReturnType<typeof createPostgresTypeParsers>;
}

export interface PostgresQueryResult {
  readonly rows: readonly Record<string, unknown>[];
}

export interface PostgresClientLike {
  query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult>;
  release(): void;
}

export interface PostgresPoolLike {
  query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult>;
  connect(): Promise<PostgresClientLike>;
  end(): Promise<void>;
}

export interface PostgresDatabase extends Database {
  close(): Promise<void>;
}

export interface PostgresDatabaseOptions {
  readonly connectionString?: string;
  readonly pool?: PostgresPoolLike;
  readonly poolConfig?: Omit<PoolConfig, "connectionString" | "types">;
  readonly typePolicy?: PostgresCodecPolicy;
  readonly decimal?: (value: string) => unknown;
}

const defaultPolicy: PostgresCodecPolicy = {
  bigint: "bigint",
  numeric: "string",
  date: "Date",
  json: "unknown",
};

function numberValue(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`${label} value ${value} cannot be represented as a finite number`);
  return parsed;
}

function safeIntegerValue(value: string): number {
  const parsed = numberValue(value, "bigint");
  if (!Number.isSafeInteger(parsed)) throw new RangeError(`bigint value ${value} exceeds JavaScript's safe integer range`);
  return parsed;
}

function scalarParsers(policy: PostgresCodecPolicy, decimal?: (value: string) => unknown): ReadonlyMap<number, (value: string) => unknown> {
  const parsers = new Map<number, (value: string) => unknown>();
  parsers.set(types.builtins.INT8, policy.bigint === "bigint" ? BigInt : policy.bigint === "number" ? safeIntegerValue : String);
  if (policy.numeric === "Decimal") {
    if (decimal === undefined) throw new TypeError("numeric=Decimal requires a decimal(value) codec");
    parsers.set(types.builtins.NUMERIC, decimal);
  } else parsers.set(types.builtins.NUMERIC, policy.numeric === "number" ? (value) => numberValue(value, "numeric") : String);

  for (const oid of [types.builtins.DATE, types.builtins.TIMESTAMP, types.builtins.TIMESTAMPTZ]) {
    parsers.set(oid, policy.date === "string" ? String : types.getTypeParser(oid, "text"));
  }
  for (const oid of [types.builtins.JSON, types.builtins.JSONB]) {
    parsers.set(oid, policy.json === "string" ? String : JSON.parse);
  }
  return parsers;
}

const arrayElementOids = new Map<number, number>([
  [1016, types.builtins.INT8],
  [1231, types.builtins.NUMERIC],
  [1182, types.builtins.DATE],
  [1115, types.builtins.TIMESTAMP],
  [1185, types.builtins.TIMESTAMPTZ],
  [199, types.builtins.JSON],
  [3807, types.builtins.JSONB],
]);

function parsePostgresArray(source: string, transform: (value: string) => unknown): unknown[] {
  let index = source.indexOf("{");
  if (index === -1) throw new TypeError("Invalid PostgreSQL array value");

  const parseLevel = (): unknown[] => {
    if (source[index] !== "{") throw new TypeError("Invalid PostgreSQL array nesting");
    index += 1;
    const result: unknown[] = [];
    while (index < source.length && source[index] !== "}") {
      if (source[index] === "{") result.push(parseLevel());
      else {
        const quoted = source[index] === '"';
        if (quoted) index += 1;
        let value = "";
        while (index < source.length) {
          const char = source[index]!;
          if (char === "\\") {
            index += 1;
            value += source[index] ?? "";
            index += 1;
          } else if (quoted ? char === '"' : char === "," || char === "}") {
            if (quoted) index += 1;
            break;
          } else {
            value += char;
            index += 1;
          }
        }
        result.push(!quoted && value === "NULL" ? null : transform(value));
      }
      if (source[index] === ",") index += 1;
    }
    if (source[index] !== "}") throw new TypeError("Unterminated PostgreSQL array value");
    index += 1;
    return result;
  };

  return parseLevel();
}

export function createPostgresTypeParsers(policy: PostgresCodecPolicy = defaultPolicy, decimal?: (value: string) => unknown): {
  readonly getTypeParser: typeof types.getTypeParser;
} {
  const scalar = scalarParsers(policy, decimal);
  return {
    getTypeParser(oid: number, format = "text") {
      if (format === "binary") return types.getTypeParser(oid, format);
      const parser = scalar.get(oid);
      if (parser !== undefined) return parser;
      const elementOid = arrayElementOids.get(oid);
      const elementParser = elementOid === undefined ? undefined : scalar.get(elementOid);
      if (elementParser !== undefined) return (source: string): unknown[] => parsePostgresArray(source, elementParser);
      return types.getTypeParser(oid, format);
    },
  };
}

function encodeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(encodeValue);
  return value;
}

function pgQueryConfig(config: PostgresQueryConfig): QueryConfig<unknown[]> {
  return {
    text: config.text,
    ...(config.values === undefined ? {} : { values: [...config.values] }),
    ...(config.types === undefined ? {} : { types: config.types }),
  };
}

function wrapPool(pool: Pool): PostgresPoolLike {
  const wrapClient = (client: PoolClient): PostgresClientLike => ({
    async query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult> {
      const result = typeof config === "string"
        ? await client.query<Record<string, unknown>>(config)
        : await client.query<Record<string, unknown>, unknown[]>(pgQueryConfig(config));
      return { rows: result.rows };
    },
    release(): void { client.release(); },
  });
  return {
    async query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult> {
      const result = typeof config === "string"
        ? await pool.query<Record<string, unknown>>(config)
        : await pool.query<Record<string, unknown>, unknown[]>(pgQueryConfig(config));
      return { rows: result.rows };
    },
    async connect(): Promise<PostgresClientLike> { return wrapClient(await pool.connect()); },
    async end(): Promise<void> { await pool.end(); },
  };
}

class PostgresDatabaseImplementation implements PostgresDatabase {
  readonly #pool: PostgresPoolLike;
  readonly #client: PostgresClientLike | undefined;
  readonly #parsers: ReturnType<typeof createPostgresTypeParsers>;
  readonly #ownsPool: boolean;
  readonly #transactionDepth: number;

  constructor(
    pool: PostgresPoolLike,
    client: PostgresClientLike | undefined,
    parsers: ReturnType<typeof createPostgresTypeParsers>,
    ownsPool: boolean,
    transactionDepth: number,
  ) {
    this.#pool = pool;
    this.#client = client;
    this.#parsers = parsers;
    this.#ownsPool = ownsPool;
    this.#transactionDepth = transactionDepth;
  }

  async execute<Row>(query: Query<Row>): Promise<readonly Row[]> {
    const executor = this.#client ?? this.#pool;
    const result = await executor.query({
      text: query.text,
      values: query.values.map(encodeValue),
      types: this.#parsers,
    });
    return result.rows as readonly Row[];
  }

  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    if (this.#client !== undefined) return this.#nestedTransaction(fn);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const transactionDatabase = new PostgresDatabaseImplementation(this.#pool, client, this.#parsers, false, 1);
      const result = await fn(transactionDatabase);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve the original transaction error. */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async #nestedTransaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    const client = this.#client!;
    const depth = this.#transactionDepth + 1;
    const savepoint = `typed_sql_${depth}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await fn(new PostgresDatabaseImplementation(this.#pool, client, this.#parsers, false, depth));
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#client !== undefined) throw new Error("Cannot close a database from inside a transaction");
    if (this.#ownsPool) await this.#pool.end();
  }
}

export function createPostgresDatabase(options: PostgresDatabaseOptions): PostgresDatabase {
  if (options.pool === undefined && options.connectionString === undefined) {
    throw new TypeError("createPostgresDatabase requires connectionString or pool");
  }
  if (options.pool !== undefined && options.connectionString !== undefined) {
    throw new TypeError("Pass either connectionString or pool, not both");
  }
  const ownsPool = options.pool === undefined;
  const pool = options.pool ?? wrapPool(new Pool({ ...options.poolConfig, connectionString: options.connectionString }));
  const parsers = createPostgresTypeParsers(options.typePolicy ?? defaultPolicy, options.decimal);
  return new PostgresDatabaseImplementation(pool, undefined, parsers, ownsPool, 0);
}
