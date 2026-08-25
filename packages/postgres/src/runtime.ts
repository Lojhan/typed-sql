import { type Database, type Query, renderQuery, type SqlRenderer } from "@typed-sql/core";
import { defaultPostgresTypePolicy } from "./type-policy.js";

export interface PostgresCodecPolicy {
  readonly bigint: "bigint" | "string" | "number";
  readonly numeric: "string" | "number" | "Decimal";
  readonly date: "Date" | "string";
  readonly json: "unknown" | "JsonValue" | "string";
}

export interface PostgresTypeParserSet {
  getTypeParser(oid: number, format?: string): (value: string) => unknown;
}

export interface PostgresQueryConfig {
  readonly text: string;
  readonly values?: readonly unknown[];
  readonly types?: PostgresTypeParserSet;
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
  readonly pool: PostgresPoolLike;
  readonly ownsPool?: boolean;
  readonly typePolicy?: PostgresCodecPolicy;
  readonly decimal?: (value: string) => unknown;
  /** Native driver parsers used for types that typed-sql does not override. */
  readonly fallbackTypeParsers?: PostgresTypeParserSet;
}

const defaultPolicy: PostgresCodecPolicy = defaultPostgresTypePolicy;

const oids = {
  int8: 20,
  date: 1082,
  timestamp: 1114,
  timestamptz: 1184,
  numeric: 1700,
  json: 114,
  jsonb: 3802,
} as const;

const arrayElementOids = new Map<number, number>([
  [1016, oids.int8],
  [1231, oids.numeric],
  [1182, oids.date],
  [1115, oids.timestamp],
  [1185, oids.timestamptz],
  [199, oids.json],
  [3807, oids.jsonb],
]);

function numberValue(input: string, label: string): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed))
    throw new RangeError(`${label} value ${input} cannot be represented as a finite number`);
  return parsed;
}

function safeIntegerValue(input: string): number {
  const parsed = numberValue(input, "bigint");
  if (!Number.isSafeInteger(parsed))
    throw new RangeError(`bigint value ${input} exceeds JavaScript's safe integer range`);
  return parsed;
}

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
        let item = "";
        while (index < source.length) {
          const char = source[index]!;
          if (char === "\\") {
            index += 1;
            item += source[index] ?? "";
            index += 1;
          } else if (quoted ? char === '"' : char === "," || char === "}") {
            if (quoted) index += 1;
            break;
          } else {
            item += char;
            index += 1;
          }
        }
        result.push(!quoted && item === "NULL" ? null : transform(item));
      }
      if (source[index] === ",") index += 1;
    }
    if (source[index] !== "}") throw new TypeError("Unterminated PostgreSQL array value");
    index += 1;
    return result;
  };
  return parseLevel();
}

export function createPostgresTypeParsers(
  policy: PostgresCodecPolicy = defaultPolicy,
  decimal?: (value: string) => unknown,
  fallback?: PostgresTypeParserSet,
): PostgresTypeParserSet {
  const scalar = new Map<number, (value: string) => unknown>();
  scalar.set(oids.int8, policy.bigint === "bigint" ? BigInt : policy.bigint === "number" ? safeIntegerValue : String);
  if (policy.numeric === "Decimal") {
    if (decimal === undefined) throw new TypeError("numeric=Decimal requires a decimal(value) codec");
    scalar.set(oids.numeric, decimal);
  } else scalar.set(oids.numeric, policy.numeric === "number" ? (input) => numberValue(input, "numeric") : String);
  for (const oid of [oids.date, oids.timestamp, oids.timestamptz]) {
    scalar.set(oid, policy.date === "string" ? String : (input) => new Date(input));
  }
  for (const oid of [oids.json, oids.jsonb]) scalar.set(oid, policy.json === "string" ? String : JSON.parse);
  return {
    getTypeParser(oid: number, format = "text") {
      if (format === "binary") return fallback?.getTypeParser(oid, format) ?? ((input: string): string => input);
      const parser = scalar.get(oid);
      if (parser !== undefined) return parser;
      const elementParser = scalar.get(arrayElementOids.get(oid) ?? -1);
      if (elementParser !== undefined) return (input: string) => parsePostgresArray(input, elementParser);
      return fallback?.getTypeParser(oid, format) ?? String;
    },
  };
}

export const postgresRenderer: SqlRenderer = Object.freeze({
  placeholder: (index: number) => `$${index}`,
  quoteIdentifier: (name: string) => `"${name.replaceAll('"', '""')}"`,
});

function encodeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return Array.isArray(value) ? value.map(encodeValue) : value;
}

class PostgresDatabaseImplementation implements PostgresDatabase {
  readonly #pool: PostgresPoolLike;
  readonly #client: PostgresClientLike | undefined;
  readonly #parsers: PostgresTypeParserSet;
  readonly #ownsPool: boolean;
  readonly #transactionDepth: number;

  constructor(
    pool: PostgresPoolLike,
    client: PostgresClientLike | undefined,
    parsers: PostgresTypeParserSet,
    ownsPool: boolean,
    depth: number,
  ) {
    this.#pool = pool;
    this.#client = client;
    this.#parsers = parsers;
    this.#ownsPool = ownsPool;
    this.#transactionDepth = depth;
  }

  async execute<Row, Params extends readonly unknown[]>(query: Query<Row, Params>): Promise<readonly Row[]> {
    const rendered = renderQuery(query, postgresRenderer);
    const result = await (this.#client ?? this.#pool).query({
      text: rendered.text,
      values: rendered.values.map(encodeValue),
      types: this.#parsers,
    });
    return result.rows as readonly Row[];
  }

  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    if (this.#client !== undefined) return this.#nestedTransaction(fn);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new PostgresDatabaseImplementation(this.#pool, client, this.#parsers, false, 1));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* Preserve the original error. */
      }
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
  return new PostgresDatabaseImplementation(
    options.pool,
    undefined,
    createPostgresTypeParsers(options.typePolicy ?? defaultPolicy, options.decimal, options.fallbackTypeParsers),
    options.ownsPool ?? false,
    0,
  );
}
