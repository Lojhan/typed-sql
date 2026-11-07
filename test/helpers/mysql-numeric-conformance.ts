import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Database, DialectPlugin, Query, SchemaSnapshot } from "@typed-sql/core";
import { strict } from "poku";
import { compileSource } from "../../packages/compiler/src/index.js";
import type { NativePrepare } from "../../scripts/language-audit/native-description/contracts.js";
import { mysqlNumericCases } from "./mysql-numeric-cases.js";

interface Column {
  engineType: number;
  flags: number;
  columnLength: number;
  decimals: number;
}
async function column(prepare: NativePrepare, sql: string): Promise<Column> {
  const result = await prepare(sql);
  strict.ok(result.accepted, sql);
  const metadata = result.metadata as { parameterCount?: number; columns?: Column[] } | undefined;
  strict.equal(metadata?.parameterCount, 0);
  strict.equal(metadata?.columns?.length, 1);
  const descriptor = metadata!.columns![0]!;
  strict.ok(
    [descriptor.engineType, descriptor.flags, descriptor.columnLength, descriptor.decimals].every(Number.isSafeInteger),
  );
  return descriptor;
}

/** Only the explicit pure regression cases execute; discovered routines remain preparation-only. */
export async function assertMySqlNumericConformance<Snapshot extends SchemaSnapshot, Policy>(
  database: Pick<Database, "all">,
  dialect: DialectPlugin<Snapshot, Policy>,
  schema: Snapshot,
  prepare: NativePrepare,
  directory: string,
): Promise<void> {
  for (const test of mysqlNumericCases) {
    const sql = `SELECT ${test.expression} AS value`,
      result = dialect.analyze(sql, schema);
    strict.deepEqual(result.diagnostics, [], sql);
    strict.deepEqual(result.parameters, []);
    strict.equal(result.columns.length, 1);
    const actual = result.columns[0]!;
    strict.equal(actual.tsType, test.type, sql);
    strict.equal(actual.nullable, test.nullable, sql);
    strict.equal(actual.databaseType, test.databaseType, sql);
    const native = await column(prepare, sql),
      claimed = await column(
        prepare,
        `SELECT * FROM JSON_TABLE('null', '$' COLUMNS (value ${actual.databaseType} PATH '$')) AS native_claim`,
      );
    strict.equal(native.engineType, claimed.engineType, sql);
    strict.equal(native.flags & 32, claimed.flags & 32, `unsigned identity: ${sql}`);
    strict.equal(actual.nullable, (native.flags & 1) === 0, `native nullability: ${sql}`);
    // NEWDECIMAL has scale/precision in these fields; integer display length is not logical width.
    if (native.engineType === 246) {
      strict.equal(native.columnLength, claimed.columnLength, sql);
      strict.equal(native.decimals, claimed.decimals, sql);
    }
  }
  const source = `import {sql} from ${JSON.stringify(dialect.runtimeSqlModule)};\nexport const queries=[${mysqlNumericCases.map(({ expression }) => `sql\`SELECT ${expression} AS value\``).join(",")}];\n`,
    compiled = compileSource({ source, schema, dialect, runtimeMetadata: true });
  strict.deepEqual(compiled.diagnostics, []);
  strict.equal(compiled.queries.length, mysqlNumericCases.length);
  const temporary = await mkdtemp(join(directory, ".mysql-numeric-runtime-"));
  try {
    const file = join(temporary, "queries.mts");
    await writeFile(file, compiled.transformedSource);
    const queries = (await import(pathToFileURL(file).href)) as { queries: Query<{ value: unknown }>[] };
    for (const [index, test] of mysqlNumericCases.entries())
      strict.deepEqual(await database.all(queries.queries[index]!), [{ value: test.value }], test.expression);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
