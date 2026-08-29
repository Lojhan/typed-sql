import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { requireAdapterCapability } from "@typed-sql/core";
import { mysqlBulk, sql as mysqlSql } from "@typed-sql/mysql";
import { createMySql2Database } from "@typed-sql/mysql/mysql2";
import { postgresCopy, sql as postgresSql } from "@typed-sql/postgres";
import { createPgDatabase } from "@typed-sql/postgres/pg";
import mysqlCallback from "mysql2";
import mysql from "mysql2/promise";
import pg from "pg";
import * as pgCopyStreams from "pg-copy-streams";

const postgresUrl = process.env.POSTGRES_URL ?? "postgresql://typed_sql:typed_sql@127.0.0.1:55432/typed_sql_benchmark";
const mysqlUrl = process.env.MYSQL_URL ?? "mysql://typed_sql:typed_sql@127.0.0.1:53306/typed_sql_benchmark";
const samples = positiveInteger("BULK_BENCHMARK_SAMPLES", 3);
const warmups = positiveInteger("BULK_BENCHMARK_WARMUPS", 1);
const rowCounts = positiveIntegerList("BULK_BENCHMARK_ROW_COUNTS", [100, 1_000, 5_000]);

interface AccountInput {
  readonly id: bigint;
  readonly email: string;
  readonly status: "active" | "suspended";
}

interface BulkCandidate {
  readonly database: "postgres" | "mysql";
  readonly strategy: "bulk" | "batch" | "pipeline" | "direct-driver";
  readonly name: string;
  reset(): Promise<void>;
  execute(rows: readonly AccountInput[]): Promise<void>;
  count(): Promise<number>;
}

interface BulkMeasurement {
  readonly database: BulkCandidate["database"];
  readonly strategy: BulkCandidate["strategy"];
  readonly name: string;
  readonly rows: number;
  readonly samples: number;
  readonly milliseconds: {
    readonly p50: number;
    readonly p95: number;
    readonly minimum: number;
    readonly maximum: number;
  };
  readonly rowsPerSecond: number;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function positiveIntegerList(name: string, fallback: readonly number[]): readonly number[] {
  const source = process.env[name];
  const values = source === undefined ? [...fallback] : source.split(",").map((value) => Number(value.trim()));
  if (values.length === 0 || values.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new TypeError(`${name} must be a comma-separated list of positive integers`);
  }
  return Object.freeze([...new Set(values)].sort((left, right) => left - right));
}

function percentile(sorted: readonly number[], ratio: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function inputRows(count: number): readonly AccountInput[] {
  return Array.from({ length: count }, (_, index) => {
    const id = BigInt(index + 1);
    return {
      id,
      email: `bulk-${id}@example.com`,
      status: index % 5 === 0 ? "suspended" : "active",
    };
  });
}

function postgresRowQuery(row: AccountInput) {
  return postgresSql`
    INSERT INTO bulk_account (id, email, status)
    VALUES (${row.id}, ${row.email}, ${row.status})
  `;
}

function mysqlRowQuery(row: AccountInput) {
  return mysqlSql`
    INSERT INTO bulk_account (id, email, status)
    VALUES (${row.id}, ${row.email}, ${row.status})
  `;
}

function tabRows(rows: readonly AccountInput[]): Readable {
  return Readable.from(
    rows.map((row) => `${row.id}\t${row.email}\t${row.status}\n`),
    { objectMode: false },
  );
}

async function measure(candidate: BulkCandidate, rows: readonly AccountInput[]): Promise<BulkMeasurement> {
  const executeOnce = async (): Promise<number> => {
    await candidate.reset();
    const start = performance.now();
    await candidate.execute(rows);
    const duration = performance.now() - start;
    const actual = await candidate.count();
    if (actual !== rows.length) {
      throw new Error(`${candidate.name} inserted ${actual} rows; expected ${rows.length}`);
    }
    return duration;
  };

  for (let index = 0; index < warmups; index += 1) await executeOnce();
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) durations.push(await executeOnce());
  durations.sort((left, right) => left - right);
  const p50 = percentile(durations, 0.5);
  return {
    database: candidate.database,
    strategy: candidate.strategy,
    name: candidate.name,
    rows: rows.length,
    samples,
    milliseconds: {
      p50,
      p95: percentile(durations, 0.95),
      minimum: durations[0] ?? 0,
      maximum: durations.at(-1) ?? 0,
    },
    rowsPerSecond: (rows.length * 1_000) / p50,
  };
}

const rawPgPool = new pg.Pool({ connectionString: postgresUrl, max: 1 });
const typedPostgres = await createPgDatabase({
  connectionString: postgresUrl,
  poolConfig: { max: 1, pipeline: true },
  copyStreamsImporter: async () => pgCopyStreams,
});
const postgresBulk = requireAdapterCapability(typedPostgres, postgresCopy);

const rawMysqlPool = mysql.createPool({ uri: mysqlUrl, connectionLimit: 1 });
const rawMysqlBulkPool = mysqlCallback.createPool(mysqlUrl);
const typedMysql = await createMySql2Database({ connectionUri: mysqlUrl, poolConfig: { connectionLimit: 1 } });
const mysqlBulkCapability = requireAdapterCapability(typedMysql, mysqlBulk);

const resetPostgres = async (): Promise<void> => {
  await rawPgPool.query("TRUNCATE TABLE bulk_account");
};
const resetMysql = async (): Promise<void> => {
  await rawMysqlPool.query("TRUNCATE TABLE bulk_account");
};
const countPostgres = async (): Promise<number> =>
  Number(
    (await rawPgPool.query<{ readonly count: string }>("SELECT COUNT(*) AS count FROM bulk_account")).rows[0]?.count,
  );
const countMysql = async (): Promise<number> => {
  const [result] = await rawMysqlPool.query("SELECT COUNT(*) AS count FROM bulk_account");
  return Number((result as unknown as readonly { readonly count: number }[])[0]?.count);
};

const candidates: readonly BulkCandidate[] = [
  {
    database: "postgres",
    strategy: "bulk",
    name: "typed-sql COPY FROM",
    reset: resetPostgres,
    execute: async (rows) => {
      await postgresBulk.copyFrom(postgresRowQuery, rows);
    },
    count: countPostgres,
  },
  {
    database: "postgres",
    strategy: "batch",
    name: "typed-sql ordered batch",
    reset: resetPostgres,
    execute: async (rows) => {
      await typedPostgres.batch(rows.map(postgresRowQuery));
    },
    count: countPostgres,
  },
  {
    database: "postgres",
    strategy: "pipeline",
    name: "typed-sql native pipeline",
    reset: resetPostgres,
    execute: async (rows) => {
      await typedPostgres.pipeline(rows.map(postgresRowQuery));
    },
    count: countPostgres,
  },
  {
    database: "postgres",
    strategy: "direct-driver",
    name: "raw pg-copy-streams",
    reset: resetPostgres,
    execute: async (rows) => {
      const client = await rawPgPool.connect();
      try {
        const sink = client.query(
          pgCopyStreams.from("COPY bulk_account (id, email, status) FROM STDIN WITH (FORMAT csv, DELIMITER E'\\t')"),
        );
        await pipeline(tabRows(rows), sink);
      } finally {
        client.release();
      }
    },
    count: countPostgres,
  },
  {
    database: "postgres",
    strategy: "direct-driver",
    name: "raw pg named inserts",
    reset: resetPostgres,
    execute: async (rows) => {
      const client = await rawPgPool.connect();
      try {
        for (const row of rows) {
          await client.query({
            name: "bulk-benchmark-account-insert",
            text: "INSERT INTO bulk_account (id, email, status) VALUES ($1, $2, $3)",
            values: [row.id, row.email, row.status],
          });
        }
      } finally {
        client.release();
      }
    },
    count: countPostgres,
  },
  {
    database: "mysql",
    strategy: "bulk",
    name: "typed-sql LOAD DATA",
    reset: resetMysql,
    execute: async (rows) => {
      await mysqlBulkCapability.loadData(mysqlRowQuery, rows);
    },
    count: countMysql,
  },
  {
    database: "mysql",
    strategy: "batch",
    name: "typed-sql ordered batch",
    reset: resetMysql,
    execute: async (rows) => {
      await typedMysql.batch(rows.map(mysqlRowQuery));
    },
    count: countMysql,
  },
  {
    database: "mysql",
    strategy: "direct-driver",
    name: "raw mysql2 LOAD DATA",
    reset: resetMysql,
    execute: (rows) =>
      new Promise<void>((resolve, reject) => {
        rawMysqlBulkPool.query(
          {
            sql: "LOAD DATA LOCAL INFILE 'typed-sql-benchmark' INTO TABLE bulk_account CHARACTER SET utf8mb4 FIELDS TERMINATED BY '\\t' LINES TERMINATED BY '\\n' (id, email, status)",
            infileStreamFactory(path) {
              if (path !== "typed-sql-benchmark") throw new Error(`Unexpected local infile path: ${path}`);
              return tabRows(rows);
            },
          },
          (error) => {
            if (error === null) resolve();
            else reject(error);
          },
        );
      }),
    count: countMysql,
  },
  {
    database: "mysql",
    strategy: "direct-driver",
    name: "raw mysql2 execute inserts",
    reset: resetMysql,
    execute: async (rows) => {
      const connection = await rawMysqlPool.getConnection();
      try {
        for (const row of rows) {
          await connection.execute("INSERT INTO bulk_account (id, email, status) VALUES (?, ?, ?)", [
            row.id.toString(),
            row.email,
            row.status,
          ]);
        }
      } finally {
        connection.release();
      }
    },
    count: countMysql,
  },
];

const results: BulkMeasurement[] = [];
try {
  for (const count of rowCounts) {
    const rows = inputRows(count);
    for (const candidate of candidates) {
      process.stdout.write(`Measuring ${candidate.database}/${candidate.name}/${count} rows... `);
      const result = await measure(candidate, rows);
      results.push(result);
      console.log(`${result.milliseconds.p50.toFixed(2)} ms p50`);
    }
  }
} finally {
  await Promise.allSettled([
    rawPgPool.end(),
    typedPostgres.close(),
    rawMysqlPool.end(),
    typedMysql.close(),
    new Promise<void>((resolve, reject) => {
      rawMysqlBulkPool.end((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    }),
  ]);
}

const output = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    rowCounts,
    samples,
    warmups,
  },
  results,
};
const root = fileURLToPath(new URL("..", import.meta.url));
await mkdir(new URL("../results", import.meta.url), { recursive: true });
await writeFile(new URL("../results/bulk-latest.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
console.table(
  results.map((result) => ({
    database: result.database,
    strategy: result.strategy,
    library: result.name,
    rows: result.rows,
    "p50 (ms)": result.milliseconds.p50.toFixed(2),
    "p95 (ms)": result.milliseconds.p95.toFixed(2),
    "rows/s": result.rowsPerSecond.toFixed(0),
  })),
);
console.log(`Machine-readable bulk results: ${root}results/bulk-latest.json`);
