import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { postgres } from "../../postgres/src/index.js";
import { analyzeSource } from "../src/index.js";

const dialect = postgres();
const schema = dialect.validateSnapshot(
  JSON.parse(await readFile(new URL("../../../test/fixtures/success/schema.json", import.meta.url), "utf8")),
);
const source = 'import { sql } from "@typed-sql/postgres"; const query = sql`SELECT COUNT(*) AS total FROM users`;';

await describe("bridge analysis facade boundaries", async () => {
  await it("forwards source/project identity and compiler limits without publishing a partial overlay", () => {
    const compiler = { maxStructuralVariants: 3, maxSourceBytes: 7, maxQueries: 2, maxGeneratedDeclarationBytes: 13 };
    const project = { id: "project", generation: 4, configHash: "config-4" };
    const result = analyzeSource(source, schema, dialect, undefined, {
      ...compiler,
      sourceId: "file:///project/query.ts",
      sourceVersion: "revision-2",
      project,
    });
    strict.strictEqual(result.identity.source.id, "file:///project/query.ts");
    strict.strictEqual(result.identity.source.version, "revision-2");
    strict.deepStrictEqual(result.identity.project, project);
    strict.deepStrictEqual(result.identity.compiler, compiler);
    strict.deepStrictEqual(result.queries, []);
    strict.strictEqual(result.transformedSource, source);
    strict.strictEqual(result.diagnostics[0]?.code, "TSQ006");
  });

  await it("forwards an explicit type policy and cancellation to the compiler", () => {
    const result = analyzeSource(source, schema, dialect, { ...dialect.defaultTypePolicy, bigint: "number" });
    strict.deepStrictEqual(result.diagnostics, []);
    strict.strictEqual(result.queries[0]?.rowType, '{ "total": number; }');
    strict.throws(
      () => analyzeSource(source, schema, dialect, undefined, { cancellation: { isCancellationRequested: true } }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
  });
});
