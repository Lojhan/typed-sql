import { strict as assert } from "node:assert";
import { renderQuery, sql } from "../../packages/core/dist/packages/core/src/index.js";
import { createMySqlDatabase, mysqlRenderer } from "../../packages/mysql/dist/packages/mysql/src/runtime.js";
import {
  createPostgresDatabase,
  createPostgresTypeParsers,
  postgresRenderer,
} from "../../packages/postgres/dist/packages/postgres/src/runtime.js";
import { measureLatency, measureThroughput } from "./harness.mjs";

function throughput(operation, methodology, iterations) {
  return {
    unit: "operations/second",
    trackingOnly: true,
    ...measureThroughput({
      operation,
      warmups: methodology.warmups,
      samples: methodology.samples,
      iterations,
    }),
  };
}

async function latency(operation, methodology, iterations) {
  return {
    unit: "ms",
    trackingOnly: true,
    ...(await measureLatency({
      operation,
      warmups: methodology.warmups,
      samples: methodology.samples,
      iterations,
    })),
  };
}

function mysqlResult(columnCount) {
  const entries = Array.from({ length: columnCount }, (_, index) => [`value_${index}`, String(index + 1)]);
  return {
    rows: [Object.fromEntries(entries)],
    fields: entries.map(([name]) => ({ name, columnType: 8 })),
  };
}

export async function deterministicMicrobenchmarks(methodology) {
  const results = {};
  const renderIterations = 10_000;
  const asyncIterations = Math.min(100, methodology.subMillisecondIterations);

  const staticQuery = sql`SELECT account.id, account.email FROM account`;
  const parameterList = sql.join(Array.from({ length: 100 }, (_, index) => sql.value(index)));
  const parameterizedQuery = sql`SELECT ${parameterList}`;

  let staticRendered;
  results["micro.render.static"] = throughput(
    () => {
      staticRendered = renderQuery(staticQuery, postgresRenderer);
    },
    methodology,
    renderIterations,
  );
  assert.equal(staticRendered.text, "SELECT account.id, account.email FROM account");
  assert.deepEqual(staticRendered.values, []);

  let parametersRendered;
  results["micro.render.100Parameters"] = throughput(
    () => {
      parametersRendered = renderQuery(parameterizedQuery, postgresRenderer);
    },
    methodology,
    renderIterations,
  );
  assert.equal(parametersRendered.values.length, 100);
  assert.ok(parametersRendered.text.endsWith("$100"));

  let postgresConfig;
  const postgresPool = {
    async query(config) {
      postgresConfig = config;
      return { rows: [] };
    },
    async connect() {
      throw new Error("microbenchmark does not acquire a connection");
    },
    async end() {},
  };
  const postgresDatabase = createPostgresDatabase({ pool: postgresPool });
  const nestedValues = [1n, [2n, [3n, 4n]], "done"];
  const postgresEncodingQuery = sql`SELECT ${nestedValues}`;
  results["micro.postgres.renderEncodeDispatch"] = await latency(
    () => postgresDatabase.execute(postgresEncodingQuery),
    methodology,
    asyncIterations,
  );
  assert.deepEqual(postgresConfig.values, [["1", ["2", ["3", "4"]], "done"]]);

  const postgresStreamRows = Array.from({ length: 100 }, (_, index) => ({ id: BigInt(index + 1) }));
  let postgresStreamReleases = 0;
  const postgresStreamingDatabase = createPostgresDatabase({
    pool: {
      async query() {
        throw new Error("stream microbenchmark must use a leased cursor");
      },
      async connect() {
        let offset = 0;
        return {
          async query() {
            throw new Error("stream microbenchmark must use a cursor");
          },
          openCursor() {
            return {
              async read(rowCount) {
                const rows = postgresStreamRows.slice(offset, offset + rowCount);
                offset += rows.length;
                return rows;
              },
              async close() {},
            };
          },
          release() {
            postgresStreamReleases += 1;
          },
        };
      },
      async end() {},
    },
  });
  let postgresStreamCount = 0;
  results["micro.postgres.stream.100Rows"] = await latency(
    async () => {
      postgresStreamCount = 0;
      for await (const _row of postgresStreamingDatabase.stream(sql`SELECT account.id FROM account`, {
        batchSize: 25,
      })) {
        postgresStreamCount += 1;
      }
    },
    methodology,
    asyncIterations,
  );
  assert.equal(postgresStreamCount, 100);
  assert.ok(postgresStreamReleases > 0);

  const postgresBatchQueries = Array.from({ length: 25 }, (_, index) => sql`SELECT ${index} AS value`);
  let postgresBatchDispatches = 0;
  let postgresBatchReleases = 0;
  const postgresBatchDatabase = createPostgresDatabase({
    pool: {
      async query() {
        throw new Error("batch microbenchmark must use one leased connection");
      },
      async connect() {
        return {
          async query() {
            postgresBatchDispatches += 1;
            return { rows: [{ value: postgresBatchDispatches }] };
          },
          release() {
            postgresBatchReleases += 1;
          },
        };
      },
      async end() {},
    },
  });
  let postgresBatchResultCount = 0;
  results["micro.postgres.batch.25Queries"] = await latency(
    async () => {
      const batchResults = await postgresBatchDatabase.batch(postgresBatchQueries);
      postgresBatchResultCount = batchResults.length;
    },
    methodology,
    asyncIterations,
  );
  assert.equal(postgresBatchResultCount, 25);
  assert.equal(postgresBatchDispatches, postgresBatchReleases * 25);

  const postgresParsers = createPostgresTypeParsers();
  const parseBigint = postgresParsers.getTypeParser(20);
  const parseNumeric = postgresParsers.getTypeParser(1700);
  const parseDate = postgresParsers.getTypeParser(1184);
  const parseJson = postgresParsers.getTypeParser(3802);
  const parseBigintArray = postgresParsers.getTypeParser(1016);
  let bigintDecoded;
  let numericDecoded;
  let dateDecoded;
  let jsonDecoded;
  let arrayDecoded;
  results["micro.postgres.decode.policySet"] = throughput(
    () => {
      bigintDecoded = parseBigint("922337203685477580");
      numericDecoded = parseNumeric("12.50");
      dateDecoded = parseDate("2026-08-26T12:00:00Z");
      jsonDecoded = parseJson('{"active":true}');
      arrayDecoded = parseBigintArray("{1,2,3}");
    },
    methodology,
    1_000,
  );
  assert.equal(bigintDecoded, 922337203685477580n);
  assert.equal(numericDecoded, "12.50");
  assert.ok(dateDecoded instanceof Date);
  assert.equal(jsonDecoded.active, true);
  assert.deepEqual(arrayDecoded, [1n, 2n, 3n]);

  const mysqlQuery = sql`SELECT 1`;
  for (const columnCount of [1, 10, 100]) {
    const result = mysqlResult(columnCount);
    const mysqlPool = {
      async execute() {
        return result;
      },
      async getConnection() {
        throw new Error("microbenchmark does not acquire a connection");
      },
      async end() {},
    };
    const mysqlDatabase = createMySqlDatabase({ pool: mysqlPool });
    let decoded;
    results[`micro.mysql.bufferedExecute.${columnCount}Columns`] = await latency(
      async () => {
        decoded = await mysqlDatabase.execute(mysqlQuery);
      },
      methodology,
      asyncIterations,
    );
    assert.equal(Object.keys(decoded[0]).length, columnCount);
    assert.equal(decoded[0].value_0, 1n);
  }

  let mysqlValues;
  const mysqlEncodingPool = {
    async execute(_text, values) {
      mysqlValues = values;
      return { rows: [], fields: [] };
    },
    async getConnection() {
      throw new Error("microbenchmark does not acquire a connection");
    },
    async end() {},
  };
  const mysqlDatabase = createMySqlDatabase({ pool: mysqlEncodingPool });
  const mysqlEncodingQuery = sql`SELECT ${nestedValues}`;
  results["micro.mysql.renderEncodeDispatch"] = await latency(
    () => mysqlDatabase.execute(mysqlEncodingQuery),
    methodology,
    asyncIterations,
  );
  assert.deepEqual(mysqlValues, [["1", ["2", ["3", "4"]], "done"]]);
  assert.equal(mysqlRenderer.placeholder(1), "?");

  const mysqlStreamRows = Array.from({ length: 100 }, (_, index) => ({ id: String(index + 1) }));
  let mysqlStreamReleases = 0;
  const mysqlStreamingDatabase = createMySqlDatabase({
    pool: {
      async execute() {
        throw new Error("stream microbenchmark must use a leased protocol stream");
      },
      async getConnection() {
        return {
          async execute() {
            throw new Error("stream microbenchmark must use protocol streaming");
          },
          async query() {
            throw new Error("stream microbenchmark does not issue transaction commands");
          },
          async beginTransaction() {},
          async commit() {},
          async rollback() {},
          stream() {
            let offset = 0;
            return {
              fields: Promise.resolve([{ name: "id", columnType: 8 }]),
              connectionReusable: true,
              [Symbol.asyncIterator]() {
                return this;
              },
              async next() {
                if (offset >= mysqlStreamRows.length) return { done: true, value: undefined };
                return { done: false, value: mysqlStreamRows[offset++] };
              },
              async close() {},
            };
          },
          release() {
            mysqlStreamReleases += 1;
          },
        };
      },
      async end() {},
    },
  });
  let mysqlStreamCount = 0;
  let mysqlStreamLastId = 0n;
  results["micro.mysql.streamDecode.100Rows"] = await latency(
    async () => {
      mysqlStreamCount = 0;
      for await (const row of mysqlStreamingDatabase.stream(sql`SELECT account.id FROM account`, { batchSize: 25 })) {
        mysqlStreamCount += 1;
        mysqlStreamLastId = row.id;
      }
    },
    methodology,
    asyncIterations,
  );
  assert.equal(mysqlStreamCount, 100);
  assert.equal(mysqlStreamLastId, 100n);
  assert.ok(mysqlStreamReleases > 0);

  const mysqlBatchQueries = Array.from({ length: 25 }, (_, index) => sql`SELECT ${index} AS value`);
  let mysqlBatchDispatches = 0;
  let mysqlBatchReleases = 0;
  const mysqlBatchDatabase = createMySqlDatabase({
    pool: {
      async execute() {
        throw new Error("batch microbenchmark must use one leased connection");
      },
      async getConnection() {
        return {
          async execute() {
            mysqlBatchDispatches += 1;
            return {
              rows: [{ value: String(mysqlBatchDispatches) }],
              fields: [{ name: "value", columnType: 8 }],
            };
          },
          async query() {
            throw new Error("batch microbenchmark does not issue transaction commands");
          },
          async beginTransaction() {},
          async commit() {},
          async rollback() {},
          release() {
            mysqlBatchReleases += 1;
          },
        };
      },
      async end() {},
    },
  });
  let mysqlBatchResultCount = 0;
  let mysqlBatchLastValue = 0n;
  results["micro.mysql.batchDecode.25Queries"] = await latency(
    async () => {
      const batchResults = await mysqlBatchDatabase.batch(mysqlBatchQueries);
      mysqlBatchResultCount = batchResults.length;
      mysqlBatchLastValue = batchResults.at(-1)?.[0]?.value ?? 0n;
    },
    methodology,
    asyncIterations,
  );
  assert.equal(mysqlBatchResultCount, 25);
  assert.equal(mysqlBatchLastValue, BigInt(mysqlBatchDispatches));
  assert.equal(mysqlBatchDispatches, mysqlBatchReleases * 25);

  return results;
}
