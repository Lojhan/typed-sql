import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { type PostgresSchemaSnapshot, postgres } from "../../postgres/src/index.js";
import { loadSchemaSnapshot } from "../../schema/src/index.js";
import {
  analyzeSource,
  compileSource,
  createSourceAnalysisService,
  SOURCE_ANALYSIS_FORMAT_VERSION,
} from "../src/index.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(testDirectory, "../../../test/fixtures/success");
const schema = (await loadSchemaSnapshot(resolve(fixtureDirectory, "schema.json"))) as PostgresSchemaSnapshot;
const dialect = postgres();
const source = await readFile(resolve(fixtureDirectory, "query.ts"), "utf8");
const context = { schema, dialect };
const request = {
  formatVersion: SOURCE_ANALYSIS_FORMAT_VERSION,
  source: { id: "src/query.ts", text: source, version: 3 },
  project: { id: "tsconfig.json", generation: 2, configHash: "sha256:project" },
} as const;

await describe("authoritative source analysis service", async () => {
  await it("returns deterministic serializable compiler, source, schema, grammar, and capability identities", () => {
    const first = analyzeSource(request, context);
    const second = createSourceAnalysisService(context).analyze(request);
    strict.deepStrictEqual(second, first);
    strict.deepStrictEqual(JSON.parse(JSON.stringify(first)), first);
    strict.strictEqual(first.formatVersion, 1);
    strict.match(first.revision, /^sha256:[a-f0-9]{64}$/u);
    strict.match(first.identity.source.hash, /^sha256:[a-f0-9]{64}$/u);
    strict.strictEqual(first.identity.source.id, "src/query.ts");
    strict.strictEqual(first.identity.source.version, 3);
    strict.deepStrictEqual(first.identity.project, request.project);
    strict.strictEqual(first.identity.grammar.id, "postgres");
    strict.strictEqual(first.identity.grammar.version, dialect.grammarVersion);
    strict.match(first.identity.grammar.capabilityFingerprint, /^sha256:[a-f0-9]{64}$/u);
    strict.match(first.identity.schema.hash, /^[a-f0-9]{64}$/u);
    strict.match(first.identity.typePolicyHash, /^[a-f0-9]{64}$/u);
    strict.ok(Object.isFrozen(first));
    strict.ok(Object.isFrozen(first.identity));
  });

  await it("uses the same transform, inferred query contract, diagnostics, and spans as batch compilation", () => {
    const analysis = analyzeSource(request, context);
    const compilation = compileSource({ source, schema, dialect });
    strict.strictEqual(analysis.transformedSource, compilation.transformedSource);
    strict.deepStrictEqual(analysis.diagnostics, compilation.diagnostics);
    strict.deepStrictEqual(
      analysis.queries.map(({ rowType, parameterType }) => ({ rowType, parameterType })),
      compilation.queries.map(({ rowType, parameterType }) => ({ rowType, parameterType })),
    );
    strict.ok(analysis.queries.every(({ sourceRange }) => sourceRange.start < sourceRange.end));
    strict.ok(analysis.queries.every(({ transformedRange }) => transformedRange.start < transformedRange.end));
  });

  await it("changes revisions for source, document, project, schema, grammar, capability, and compiler inputs", () => {
    const baseline = analyzeSource(request, context).revision;
    const revisions = [
      analyzeSource({ ...request, source: { ...request.source, version: 4 } }, context).revision,
      analyzeSource({ ...request, source: { ...request.source, text: `${source}\n` } }, context).revision,
      analyzeSource({ ...request, project: { ...request.project, generation: 3 } }, context).revision,
      analyzeSource({ ...request, compiler: { maxQueries: 100 } }, context).revision,
      analyzeSource(request, { ...context, schema: { ...schema, version: "18.7" } }).revision,
    ];
    strict.ok(revisions.every((revision) => revision !== baseline));
    strict.strictEqual(new Set(revisions).size, revisions.length);
  });

  await it("fails closed at source, query-count, and generated-declaration limits", () => {
    const sourceLimited = analyzeSource({ ...request, compiler: { maxSourceBytes: 1 } }, context);
    strict.deepStrictEqual(sourceLimited.queries, []);
    strict.strictEqual(sourceLimited.transformedSource, source);
    strict.strictEqual(sourceLimited.diagnostics[0]?.code, "TSQ006");

    const twoQueries = `${source}\nconst another = sql\`SELECT 1 AS another\`;`;
    const queryLimited = analyzeSource(
      { ...request, source: { ...request.source, text: twoQueries }, compiler: { maxQueries: 1 } },
      context,
    );
    strict.deepStrictEqual(queryLimited.queries, []);
    strict.strictEqual(queryLimited.transformedSource, twoQueries);
    strict.strictEqual(queryLimited.diagnostics[0]?.code, "TSQ006");

    const declarationLimited = analyzeSource({ ...request, compiler: { maxGeneratedDeclarationBytes: 1 } }, context);
    strict.deepStrictEqual(declarationLimited.queries, []);
    strict.strictEqual(declarationLimited.transformedSource, source);
    strict.strictEqual(declarationLimited.diagnostics[0]?.code, "TSQ006");
  });

  await it("rejects malformed requests and cancellation without publishing partial success", () => {
    strict.throws(
      () => analyzeSource({ ...request, source: { ...request.source, id: "" } }, context),
      /non-empty string/u,
    );
    strict.throws(() => analyzeSource({ ...request, compiler: { maxQueries: 0 } }, context), /positive safe integer/u);
    strict.throws(
      () => analyzeSource(request, context, { isCancellationRequested: true }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
  });
});
