import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { sql as mysqlSql } from "@typed-sql/mysql";
import { createMySql2Database } from "@typed-sql/mysql/mysql2";
import { sql as postgresSql } from "@typed-sql/postgres";
import { createPgDatabase } from "@typed-sql/postgres/pg";
import { sql as drizzleSql, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { bigint, pgTable, text } from "drizzle-orm/pg-core";
import { Kysely, PostgresDialect } from "kysely";
import mysql from "mysql2/promise";
import pg from "pg";
import { DataSource, EntitySchema } from "typeorm";
import { PrismaClient } from "./generated/prisma/client.js";

const postgresUrl = process.env.POSTGRES_URL ?? "postgresql://typed_sql:typed_sql@127.0.0.1:55432/typed_sql_benchmark";
const mysqlUrl = process.env.MYSQL_URL ?? "mysql://typed_sql:typed_sql@127.0.0.1:53306/typed_sql_benchmark";
const iterations = positiveInteger("BENCHMARK_ITERATIONS", 1_000);
const samples = positiveInteger("BENCHMARK_SAMPLES", 12);
const warmups = positiveInteger("BENCHMARK_WARMUPS", 250);
const accountId = 512n;

interface AccountRow {
  readonly id: bigint | string;
  readonly email: string;
  readonly status: string;
}

interface Database {
  account: AccountRow;
}

interface Measurement {
  readonly name: string;
  readonly workload: "request" | "prepared";
  readonly driver: "postgres" | "mysql";
  readonly iterations: number;
  readonly samples: number;
  readonly milliseconds: {
    readonly p50: number;
    readonly p95: number;
    readonly minimum: number;
    readonly maximum: number;
  };
  readonly operationsPerSecond: number;
}

interface Candidate {
  readonly name: string;
  readonly workload: Measurement["workload"];
  readonly driver: Measurement["driver"];
  readonly execute: () => Promise<unknown>;
  readonly close?: () => Promise<void>;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function percentile(sorted: readonly number[], ratio: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function assertAccount(value: unknown): void {
  if (Array.isArray(value)) {
    assertAccount(value[0]);
    return;
  }
  if (typeof value !== "object" || value === null) throw new Error("Benchmark query returned no account");
  const row = value as Record<string, unknown>;
  const id = row.id ?? row.account_id;
  if (String(id) !== String(accountId) || row.email !== "person-512@example.com" || row.status !== "active") {
    throw new Error(`Benchmark query returned an unexpected row: ${JSON.stringify(value)}`);
  }
}

async function measure(candidate: Candidate): Promise<Measurement> {
  for (let index = 0; index < warmups; index += 1) assertAccount(await candidate.execute());
  const durations: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const start = performance.now();
    let last: unknown;
    for (let index = 0; index < iterations; index += 1) last = await candidate.execute();
    durations.push((performance.now() - start) / iterations);
    assertAccount(last);
  }
  durations.sort((left, right) => left - right);
  const p50 = percentile(durations, 0.5);
  return {
    name: candidate.name,
    workload: candidate.workload,
    driver: candidate.driver,
    iterations,
    samples,
    milliseconds: {
      p50,
      p95: percentile(durations, 0.95),
      minimum: durations[0] ?? 0,
      maximum: durations.at(-1) ?? 0,
    },
    operationsPerSecond: 1_000 / p50,
  };
}

const accounts = pgTable("account", {
  id: bigint({ mode: "bigint" }).primaryKey(),
  email: text().notNull(),
  status: text().notNull(),
});

const rawPgPool = new pg.Pool({ connectionString: postgresUrl, max: 10 });
const typedPostgres = await createPgDatabase({ connectionString: postgresUrl, poolConfig: { max: 10 } });
const typedPostgresById = typedPostgres.prepare(
  "benchmark-typed-account-by-id",
  (id: bigint) =>
    postgresSql<AccountRow>`SELECT account.id, account.email, account.status FROM account WHERE account.id = ${id}`,
);
const drizzlePool = new pg.Pool({ connectionString: postgresUrl, max: 10 });
const drizzleDb = drizzle({ client: drizzlePool });
const drizzlePrepared = drizzleDb
  .select({ id: accounts.id, email: accounts.email, status: accounts.status })
  .from(accounts)
  .where(eq(accounts.id, drizzleSql.placeholder("id")))
  .prepare("benchmark-drizzle-account-by-id");
const kyselyPool = new pg.Pool({ connectionString: postgresUrl, max: 10 });
const kysely = new Kysely<Database>({ dialect: new PostgresDialect({ pool: kyselyPool }) });
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: postgresUrl }) });
const accountEntity = new EntitySchema<AccountRow>({
  name: "Account",
  tableName: "account",
  columns: {
    id: { type: "bigint", primary: true },
    email: { type: "text" },
    status: { type: "text" },
  },
});
const typeorm = await new DataSource({
  type: "postgres",
  url: postgresUrl,
  poolSize: 10,
  entities: [accountEntity],
}).initialize();

const rawMysqlPool = mysql.createPool({ uri: mysqlUrl, connectionLimit: 10 });
const typedMysql = await createMySql2Database({ connectionUri: mysqlUrl, poolConfig: { connectionLimit: 10 } });
const typedMysqlById = typedMysql.prepare(
  "benchmark-typed-account-by-id",
  (id: bigint) =>
    mysqlSql<AccountRow>`SELECT account.id, account.email, account.status FROM account WHERE account.id = ${id}`,
);

const candidates: readonly Candidate[] = [
  {
    name: "raw pg",
    workload: "request",
    driver: "postgres",
    execute: async () =>
      (await rawPgPool.query("SELECT id, email, status FROM account WHERE id = $1", [accountId])).rows,
  },
  {
    name: "typed-sql",
    workload: "request",
    driver: "postgres",
    execute: () =>
      typedPostgres.execute(
        postgresSql<AccountRow>`SELECT account.id, account.email, account.status FROM account WHERE account.id = ${accountId}`,
      ),
  },
  {
    name: "Drizzle",
    workload: "request",
    driver: "postgres",
    execute: () =>
      drizzleDb
        .select({ id: accounts.id, email: accounts.email, status: accounts.status })
        .from(accounts)
        .where(eq(accounts.id, accountId)),
  },
  {
    name: "Kysely",
    workload: "request",
    driver: "postgres",
    execute: () => kysely.selectFrom("account").select(["id", "email", "status"]).where("id", "=", accountId).execute(),
  },
  {
    name: "Prisma",
    workload: "request",
    driver: "postgres",
    execute: () =>
      prisma.account.findUnique({
        where: { id: accountId },
        select: { id: true, email: true, status: true },
      }),
  },
  {
    name: "TypeORM",
    workload: "request",
    driver: "postgres",
    execute: () =>
      typeorm
        .createQueryBuilder()
        .select(["account.id AS id", "account.email AS email", "account.status AS status"])
        .from(accountEntity, "account")
        .where("account.id = :id", { id: accountId })
        .getRawOne(),
  },
  {
    name: "raw pg named prepared",
    workload: "prepared",
    driver: "postgres",
    execute: async () =>
      (
        await rawPgPool.query({
          name: "benchmark-raw-account-by-id",
          text: "SELECT id, email, status FROM account WHERE id = $1",
          values: [accountId],
        })
      ).rows,
  },
  {
    name: "typed-sql prepared",
    workload: "prepared",
    driver: "postgres",
    execute: () => typedPostgres.execute(typedPostgresById(accountId)),
  },
  {
    name: "Drizzle prepared",
    workload: "prepared",
    driver: "postgres",
    execute: () => drizzlePrepared.execute({ id: accountId }),
  },
  {
    name: "raw mysql2 execute",
    workload: "request",
    driver: "mysql",
    execute: async () =>
      (await rawMysqlPool.execute("SELECT id, email, status FROM account WHERE id = ?", [accountId]))[0],
  },
  {
    name: "typed-sql",
    workload: "request",
    driver: "mysql",
    execute: () =>
      typedMysql.execute(
        mysqlSql<AccountRow>`SELECT account.id, account.email, account.status FROM account WHERE account.id = ${accountId}`,
      ),
  },
  {
    name: "typed-sql prepared",
    workload: "prepared",
    driver: "mysql",
    execute: () => typedMysql.execute(typedMysqlById(accountId)),
  },
];

const results: Measurement[] = [];
try {
  for (const candidate of candidates) {
    process.stdout.write(`Measuring ${candidate.driver}/${candidate.workload}/${candidate.name}... `);
    const result = await measure(candidate);
    results.push(result);
    console.log(`${result.milliseconds.p50.toFixed(3)} ms p50`);
  }
} finally {
  await Promise.allSettled([
    rawPgPool.end(),
    typedPostgres.close(),
    drizzlePool.end(),
    kysely.destroy(),
    prisma.$disconnect(),
    typeorm.destroy(),
    rawMysqlPool.end(),
    typedMysql.close(),
  ]);
}

const output = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    iterations,
    samples,
    warmups,
  },
  results,
};
const root = fileURLToPath(new URL("..", import.meta.url));
await mkdir(new URL("../results", import.meta.url), { recursive: true });
await writeFile(new URL("../results/latest.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
console.table(
  results.map((result) => ({
    database: result.driver,
    workload: result.workload,
    library: result.name,
    "p50 (ms)": result.milliseconds.p50.toFixed(3),
    "p95 (ms)": result.milliseconds.p95.toFixed(3),
    "ops/s": result.operationsPerSecond.toFixed(0),
  })),
);
console.log(`Machine-readable results: ${root}results/latest.json`);
