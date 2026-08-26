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

  return results;
}
