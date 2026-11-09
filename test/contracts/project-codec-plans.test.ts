import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import {
  buildQueryValuePlan,
  collectSourceQueryCandidates,
  collectSqlFileQueryCandidates,
  compileSource,
} from "../../packages/compiler/src/index.js";
import type { DialectPlugin, RuntimeValueType, SchemaSnapshot } from "../../packages/core/src/index.js";
import { commerceFiles } from "../../website/.vitepress/theme/playground/commerce-example.js";
import { isPlaygroundDialect } from "../../website/.vitepress/theme/playground/schema-catalog.js";
import { analyzeSqlFiles } from "../../website/.vitepress/theme/playground/workspace-sql.js";

function knownCodec(type: RuntimeValueType): boolean {
  if (typeof type === "string") return type !== "unknown";
  if ("union" in type) return type.union.every(knownCodec);
  if ("array" in type) return knownCodec(type.array);
  if ("object" in type) return Object.values(type.object).every((field) => knownCodec(field.type));
  if ("tuple" in type) return type.tuple.every((field) => knownCodec(field.type));
  return true;
}

await describe("maintained project codec plans", async () => {
  const ledger = JSON.parse(await readFile(new URL("../../grammar/features/ledger.json", import.meta.url), "utf8"));
  const grammars = Object.keys(ledger.dialects).sort();
  strict.ok(grammars.length > 0);
  for (const grammar of grammars) {
    await it(`${grammar} retains codecs for every finite maintained commerce query`, async () => {
      if (!isPlaygroundDialect(grammar)) throw Error(`Missing maintained project workload for ${grammar}`);
      const module = (await import(
        new URL(`../../packages/${grammar}/src/analysis.ts`, import.meta.url).href
      )) as Record<string, unknown>;
      const factory = module[grammar];
      if (typeof factory !== "function") throw Error(`Missing analysis factory for ${grammar}`);
      const dialect = (factory as () => DialectPlugin<SchemaSnapshot, unknown>)();
      const files = commerceFiles(grammar);
      const modeled = analyzeSqlFiles(grammar, files);
      strict.deepEqual(
        modeled.problems.filter(({ severity }) => severity === "error"),
        [],
      );
      strict.ok(modeled.snapshot);
      const schema = dialect.validateSnapshot(modeled.snapshot);
      const queries = Object.entries(files).filter(
        ([file]) => file.startsWith("queries/") && /\.(?:ts|sql)$/u.test(file),
      );
      let checked = 0;
      for (const [file, source] of queries) {
        const collection = (file.endsWith(".sql") ? collectSqlFileQueryCandidates : collectSourceQueryCandidates)({
          source,
          profile: dialect,
          schema,
        });
        if (file.endsWith(".ts")) {
          const compiled = compileSource({ source, schema, dialect, runtimeMetadata: true });
          strict.deepEqual(
            compiled.diagnostics.filter(({ severity }) => severity === "error"),
            [],
            `${grammar}/${file}`,
          );
          strict.ok(compiled.queries.length > 0, `${grammar}/${file} contains no compiled query`);
        }
        if (!collection.complete) {
          // Runtime-sized fragments remain compiled above, but have no finite exact contract set.
          strict.ok(collection.diagnostics.length > 0, `${grammar}/${file} silently omitted an exact rendering`);
          strict.ok(
            collection.diagnostics.every(({ code }) => code === "TSQ013"),
            `${grammar}/${file} has an unexpected rendering failure`,
          );
          continue;
        }
        strict.deepEqual(collection.diagnostics, []);
        strict.ok(collection.candidates.length > 0, `${grammar}/${file} contains no exact candidates`);
        for (const candidate of collection.candidates) {
          const analysis = dialect.analyze(candidate.sql, schema);
          strict.deepEqual(
            analysis.diagnostics.filter(({ severity }) => severity === "error"),
            [],
            `${grammar}/${file}`,
          );
          const plan = buildQueryValuePlan(
            dialect,
            analysis,
            dialect.defaultTypePolicy,
            candidate.logicalParameterCount,
          );
          const unresolved = [...plan.columns, ...plan.parameters].filter(
            (value) => value.json === undefined && !knownCodec(value.type),
          );
          strict.deepEqual(unresolved, [], `${grammar}/${file} lost a runtime codec`);
          strict.equal(plan.columns.length, analysis.columns.length);
          strict.equal(plan.parameters.length, candidate.logicalParameterCount);
          checked++;
        }
      }
      strict.ok(checked > 0, `${grammar} did not check any exact queries`);
    });
  }
});
