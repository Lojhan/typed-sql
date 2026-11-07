import { readFile } from "node:fs/promises";

const legacy = process.env.TYPED_SQL_DUCKDB_SDK === "15";
const sdk = legacy ? await import("duckdb-node-15") : await import("@duckdb/node-api");
const version = legacy ? "1.5.6" : "2.0.0";

import { it, strict } from "poku";
import { duckdb } from "../src/index.js";
import { fixtureEvidence } from "./helpers/evidence.js";

await it("retains every automatically discovered native binding/analysis regression", async () => {
  const data: {
    profiles: Record<
      string,
      {
        witnesses: {
          sql: string;
          nativeAccepted: boolean;
          requireNativeType?: boolean;
          requireUnknownResult?: boolean;
        }[];
      }
    >;
  } = JSON.parse(
    await readFile(
      new URL("../../../test/fixtures/language-audit/duckdb-shape-regressions.json", import.meta.url),
      "utf8",
    ),
  );
  const fixture = data.profiles[version]!;
  strict.equal(sdk.version(), `v${version}`);
  const instance = await sdk.DuckDBInstance.create(),
    connection = await instance.connect();
  const grammar = duckdb(),
    snapshot = {
      formatVersion: 1 as const,
      dialect: "duckdb" as const,
      server: fixtureEvidence(version),
      tables: {},
    };
  try {
    for (const witness of fixture.witnesses) {
      let accepted = false;
      try {
        const prepared = await connection.prepare(witness.sql);
        accepted = true;
        prepared.destroySync();
      } catch (error) {
        strict.match(String(error), /(?:Binder|Parser|Invalid Input) Error/u);
      }
      strict.equal(accepted, witness.nativeAccepted, witness.sql);
      const analysis = grammar.analyze(witness.sql, snapshot);
      if (witness.requireUnknownResult) {
        strict.ok(
          analysis.diagnostics.some((diagnostic) => diagnostic.code === "TSQ401"),
          witness.sql,
        );
        strict.ok(
          analysis.columns.every((column) => column.tsType === "unknown"),
          witness.sql,
        );
      }
      if (witness.requireNativeType) {
        strict.deepEqual(analysis.diagnostics, [], witness.sql);
        strict.ok(analysis.columns[0]?.databaseType && analysis.columns[0].tsType !== "unknown", witness.sql);
        const expected = await connection.prepare(witness.sql);
        const claimed = await connection.prepare(`SELECT CAST(NULL AS ${analysis.columns[0]!.databaseType})`);
        try {
          strict.deepEqual(claimed.columnType(0).toJson(), expected.columnType(0).toJson(), witness.sql);
        } finally {
          claimed.destroySync();
          expected.destroySync();
        }
      }
      strict.equal(analysis.parameters.length, 0, witness.sql);
      strict.ok(
        analysis.columns.every((column) => column.tsType !== "any"),
        witness.sql,
      );
      if (!accepted)
        strict.ok(
          analysis.diagnostics.length > 0 || analysis.columns.every((column) => column.tsType === "unknown"),
          witness.sql,
        );
      for (const range of [
        ...analysis.columns.map((column) => column.range),
        ...analysis.diagnostics.map((diagnostic) => diagnostic.range),
      ]) {
        strict.ok(range.start >= 0 && range.end >= range.start && range.end <= witness.sql.length, witness.sql);
      }
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});

await it("qualifies value-dependent table schemas with NULL and non-NULL parameter bindings", async () => {
  const instance = await sdk.DuckDBInstance.create(),
    connection = await instance.connect();
  const grammar = duckdb(),
    snapshot = { formatVersion: 1 as const, dialect: "duckdb" as const, server: fixtureEvidence(version), tables: {} };
  try {
    for (const name of ["range", "generate_series"])
      for (const type of ["TIMESTAMP", "TIMESTAMP WITH TIME ZONE"]) {
        const sql = `SELECT * FROM ${name}(CAST($1 AS ${type}),CAST($2 AS ${type}),CAST($3 AS INTERVAL))`;
        const statement = await connection.prepare(sql);
        try {
          for (let index = 1; index <= 3; index++) statement.bindNull(index);
          const empty = await statement.run();
          strict.equal(
            empty.columnTypeId(0),
            legacy
              ? sdk.DuckDBTypeId.BIGINT
              : type === "TIMESTAMP"
                ? sdk.DuckDBTypeId.TIMESTAMP
                : sdk.DuckDBTypeId.TIMESTAMP_TZ,
          );
          statement.bindVarchar(1, "2020-01-01");
          statement.bindVarchar(2, "2020-01-02");
          statement.bindVarchar(3, "1 day");
          const populated = await statement.run();
          strict.equal(
            populated.columnTypeId(0),
            type === "TIMESTAMP" ? sdk.DuckDBTypeId.TIMESTAMP : sdk.DuckDBTypeId.TIMESTAMP_TZ,
          );
        } finally {
          statement.destroySync();
        }
        const analysis = grammar.analyze(sql, snapshot);
        strict.deepEqual(
          analysis.parameters.map((parameter) => parameter.index),
          [1, 2, 3],
        );
        if (legacy) {
          strict.ok(analysis.diagnostics.some((diagnostic) => diagnostic.code === "TSQ401"));
          strict.ok(analysis.columns.every((column) => column.tsType === "unknown"));
        } else {
          strict.deepEqual(analysis.diagnostics, []);
          strict.equal(analysis.columns[0]?.databaseType, type === "TIMESTAMP" ? "TIMESTAMP" : "TIMESTAMPTZ");
        }
        strict.ok(analysis.columns.every((column) => column.tsType !== "any"));
      }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});
