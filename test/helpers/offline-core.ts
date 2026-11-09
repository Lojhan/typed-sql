import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { DialectPlugin } from "@typed-sql/core";
import { strict } from "poku";
import type { SchemaSnapshot } from "../../packages/schema/src/index.js";
import { recognitionQueries } from "../../scripts/language-audit/queries.js";

/** Compare an independently discovered invocation inventory, without declaring another function list. */
export function assertOfflineCoreParity<Snapshot extends SchemaSnapshot, Policy>(input: {
  readonly full: DialectPlugin<Snapshot, Policy>;
  readonly core: DialectPlugin<Snapshot, Policy>;
  readonly schema: Snapshot;
  readonly rows: readonly Parameters<typeof recognitionQueries>[0][];
  readonly omitted: (
    diagnostic: ReturnType<DialectPlugin<Snapshot, Policy>["analyze"]>["diagnostics"][number],
  ) => boolean;
}) {
  let total = 0,
    maintained = 0,
    unmapped = 0;
  for (const row of input.rows)
    for (const sql of recognitionQueries(row)) {
      const expected = input.full.analyze(sql, input.schema);
      const actual = input.core.analyze(sql, input.schema);
      total++;
      if (expected.diagnostics.some(input.omitted)) {
        unmapped++;
        strict.ok(
          actual.diagnostics.some((item) => item.code === "TSQ408" && item.severity === "error"),
          sql,
        );
        strict.deepEqual(actual.columns, expected.columns, sql);
        strict.deepEqual(actual.parameters, expected.parameters, sql);
        strict.deepEqual(
          actual.diagnostics.filter((item) => item.code !== "TSQ408"),
          expected.diagnostics.filter((item) => !input.omitted(item)),
          sql,
        );
      } else {
        maintained++;
        strict.deepEqual(actual, expected, sql);
      }
    }
  strict.ok(total > 0 && maintained > 0 && unmapped > 0);
  return { total, maintained, unmapped };
}

export async function assertPortableCoreGraph(grammar: string, factory: string) {
  const esbuild = createRequire(new URL("../../packages/build/package.json", import.meta.url))("esbuild");
  const entry = fileURLToPath(new URL(`../../packages/${grammar}/src/analysis/core.ts`, import.meta.url));
  const built = await esbuild.build({
    absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
    stdin: {
      contents: `export {${factory}} from ${JSON.stringify(entry)}`,
      loader: "ts",
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
  });
  const inputs = Object.keys(built.metafile.inputs);
  strict.ok(inputs.some((input) => input.endsWith(`/${grammar}/src/resolver.ts`)));
  strict.ok(inputs.some((input) => input.includes(`/${grammar}/src/catalog/`)));
  for (const forbidden of [
    "provider.ts",
    "node-sqlite.ts",
    "node-sqlite-contracts.ts",
    "native-contracts.ts",
    "odbc-native.ts",
    "odbc-contracts.ts",
    "msnodesqlv8.ts",
  ])
    strict.ok(!inputs.some((input) => input.endsWith(`/${grammar}/src/${forbidden}`)), forbidden);
  strict.ok(
    !inputs.some((input) => /node_modules\/(?:koffi|mssql|tedious|msnodesqlv8|@libsql\/client)\//u.test(input)),
  );
}
