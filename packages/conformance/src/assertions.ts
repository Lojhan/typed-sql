import { strict as assert } from "node:assert";
import { compileSource } from "@typed-sql/compiler";
import {
  assertDialectPlugin,
  createDatabase,
  DIALECT_CONTRACT_VERSION,
  type DialectAnalysis,
  defineConfig,
  parameterTypeLiteral,
  QUERY_SEMANTICS_VERSION,
  type QuerySemantics,
  renderQuery,
  rowTypeLiteral,
  type SchemaSnapshot,
  type SourceRange,
} from "@typed-sql/core";
import {
  type CodecConformanceFixture,
  GRAMMAR_CONFORMANCE_VERSION,
  type GrammarAnalysisProbe,
  type GrammarConformanceFixture,
  type GrammarConformanceReport,
  type GrammarDependencyExpectation,
  type GrammarSemanticExpectation,
  type GrammarUnsupportedProbe,
  REQUIRED_GRAMMAR_PROBES,
  type RuntimeAdapterConformanceFixture,
} from "./types.js";

export function defineGrammarConformanceFixture<Snapshot extends SchemaSnapshot, Policy>(
  fixture: GrammarConformanceFixture<Snapshot, Policy>,
): GrammarConformanceFixture<Snapshot, Policy> {
  return Object.freeze(fixture);
}

export function defineCodecConformanceFixture<Input, Output>(
  fixture: CodecConformanceFixture<Input, Output>,
): CodecConformanceFixture<Input, Output> {
  return Object.freeze(fixture);
}

function assertRange(range: SourceRange, length: number, label: string): void {
  assert.ok(Number.isSafeInteger(range.start) && range.start >= 0, `${label} has an invalid start offset`);
  assert.ok(Number.isSafeInteger(range.end) && range.end >= range.start, `${label} has an invalid end offset`);
  assert.ok(range.end <= length, `${label} extends beyond its SQL source`);
  assert.ok(Number.isSafeInteger(range.line) && range.line >= 1, `${label} has an invalid line`);
  assert.ok(Number.isSafeInteger(range.column) && range.column >= 1, `${label} has an invalid column`);
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  assert.ok(Object.isFrozen(value), "semantic metadata must be deeply frozen");
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function dependencyMatches(
  actual: QuerySemantics["dependencies"][number],
  expected: GrammarDependencyExpectation,
): boolean {
  return (
    actual.kind === expected.kind &&
    actual.access === expected.access &&
    actual.name === expected.name &&
    actual.schema === expected.schema &&
    actual.parent === expected.parent
  );
}

function assertSemantics(
  semantics: QuerySemantics,
  expected: GrammarSemanticExpectation,
  sqlLength: number,
  label: string,
): void {
  assert.strictEqual(semantics.version, QUERY_SEMANTICS_VERSION, `${label} uses incompatible semantic metadata`);
  assert.strictEqual(semantics.operation.value, expected.operation, `${label} operation`);
  assert.strictEqual(semantics.volatility.value, expected.volatility, `${label} volatility`);
  assert.strictEqual(semantics.locking.value, expected.locking ?? "none", `${label} locking`);
  assert.strictEqual(
    semantics.connectionAffinity.value,
    expected.connectionAffinity ?? "none",
    `${label} connection affinity`,
  );
  assert.strictEqual(semantics.cardinality.minimum, expected.cardinalityMinimum ?? 0, `${label} cardinality minimum`);
  assert.strictEqual(semantics.cardinality.maximum, expected.cardinalityMaximum, `${label} cardinality maximum`);
  if (expected.capabilities !== undefined) {
    assert.deepStrictEqual(semantics.capabilities, [...expected.capabilities].sort(), `${label} semantic capabilities`);
  }
  for (const dependency of expected.dependencies ?? []) {
    assert.ok(
      semantics.dependencies.some((actual) => dependencyMatches(actual, dependency)),
      `${label} is missing ${dependency.kind} dependency ${dependency.name}`,
    );
  }
  for (const [factName, evidence] of [
    ["operation", semantics.operation.evidence],
    ["cardinality", semantics.cardinality.evidence],
    ["volatility", semantics.volatility.evidence],
    ["locking", semantics.locking.evidence],
    ["connection affinity", semantics.connectionAffinity.evidence],
  ] as const) {
    assert.ok(evidence.length > 0, `${label} ${factName} has no evidence`);
    for (const [index, item] of evidence.entries())
      assertRange(item.range, sqlLength, `${label} ${factName}[${index}]`);
  }
  for (const [index, dependency] of semantics.dependencies.entries()) {
    assertRange(dependency.range, sqlLength, `${label} dependency[${index}]`);
  }
  assertDeepFrozen(semantics);
}

function assertNoAny(value: string, label: string): void {
  assert.ok(!/(?:^|[^A-Za-z])any(?:$|[^A-Za-z])/u.test(value), `${label} resolved to any`);
}

function assertAnalysis(analysis: DialectAnalysis, probe: GrammarAnalysisProbe, label: string): void {
  const diagnosticCodes = analysis.diagnostics.map(({ code }) => code);
  assert.deepStrictEqual(diagnosticCodes, probe.expectedDiagnosticCodes ?? [], `${label} diagnostics`);
  assert.strictEqual(analysis.resultKind ?? "rows", probe.expectedResultKind, `${label} result kind`);
  const rowType = rowTypeLiteral(analysis.columns);
  const parameterType = parameterTypeLiteral(probe.parameterCount, analysis.parameters);
  assert.strictEqual(rowType, probe.expectedRowType, `${label} row type`);
  assert.strictEqual(parameterType, probe.expectedParameterType, `${label} parameter type`);
  assertNoAny(rowType, `${label} row type`);
  assertNoAny(parameterType, `${label} parameter type`);
  for (const [index, column] of analysis.columns.entries()) {
    assertRange(column.range, probe.sql.length, `${label} column[${index}]`);
  }
  assertSemantics(analysis.semantics, probe.expectedSemantics, probe.sql.length, label);
}

function templateLiteralText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}

function assertUnsupported<Snapshot extends SchemaSnapshot, Policy>(
  fixture: GrammarConformanceFixture<Snapshot, Policy>,
  probe: GrammarUnsupportedProbe,
  label: string,
): void {
  const analysis = fixture.dialect.analyze(probe.sql, fixture.snapshot);
  assert.ok(
    analysis.diagnostics.some(({ code, severity }) => code === probe.diagnosticCode && severity === "error"),
    `${label} did not report ${probe.diagnosticCode}`,
  );
  assert.strictEqual(analysis.semantics.operation.value, "unknown", `${label} operation must fail closed`);
  assert.strictEqual(analysis.semantics.volatility.value, "unknown", `${label} volatility must fail closed`);
  assert.strictEqual(analysis.semantics.locking.value, "unknown", `${label} locking must fail closed`);
  assert.strictEqual(
    analysis.semantics.connectionAffinity.value,
    "unknown",
    `${label} connection affinity must fail closed`,
  );
  assert.strictEqual(analysis.semantics.cardinality.maximum, "unknown", `${label} cardinality must fail closed`);
  const source = [
    `import { sql } from ${JSON.stringify(fixture.dialect.sqlModule)};`,
    "const query = sql`",
    templateLiteralText(probe.sql),
    "`;",
  ].join("\n");
  const compiled = compileSource({ source, dialect: fixture.dialect, schema: fixture.snapshot });
  assert.strictEqual(compiled.queries.length, 0, `${label} was optimistically compiled`);
  assert.ok(
    compiled.diagnostics.some(({ code }) => code === probe.diagnosticCode),
    `${label} compiler diagnostic`,
  );
}

export function assertGrammarConformance<Snapshot extends SchemaSnapshot, Policy>(
  fixture: GrammarConformanceFixture<Snapshot, Policy>,
): GrammarConformanceReport {
  assert.strictEqual(fixture.version, GRAMMAR_CONFORMANCE_VERSION, "Unsupported grammar conformance fixture");
  assertDialectPlugin(fixture.dialect);
  assert.strictEqual(fixture.dialect.contractVersion, DIALECT_CONTRACT_VERSION);
  assert.doesNotThrow(() =>
    defineConfig({
      dialect: fixture.dialect,
      schema: { file: "schema.json" },
      outDir: "generated",
      typePolicy: fixture.dialect.defaultTypePolicy,
    }),
  );
  assert.ok(Object.values(fixture.dialect.capabilities).every((supported) => typeof supported === "boolean"));
  assert.strictEqual(fixture.dialect.placeholder(2), fixture.placeholderTwo);
  assert.strictEqual(fixture.dialect.placeholder(2), fixture.renderer.placeholder(2));
  assert.throws(() => fixture.dialect.placeholder(0));
  assert.strictEqual(fixture.dialect.quoteIdentifier(fixture.identifier), fixture.quotedIdentifier);
  assert.strictEqual(
    fixture.dialect.quoteIdentifier(fixture.identifier),
    fixture.renderer.quoteIdentifier(fixture.identifier),
  );
  assert.strictEqual(fixture.dialect.validateSnapshot(fixture.snapshot).dialect, fixture.dialect.id);
  assert.throws(() =>
    fixture.dialect.validateSnapshot({ ...fixture.snapshot, dialect: `${fixture.dialect.id}-other` }),
  );
  assert.throws(() => fixture.dialect.validateSnapshot({ ...fixture.snapshot, dialectVersion: "incompatible" }));

  assert.deepStrictEqual(Object.keys(fixture.probes).sort(), [...REQUIRED_GRAMMAR_PROBES].sort());
  for (const probeName of REQUIRED_GRAMMAR_PROBES) {
    const probe = fixture.probes[probeName];
    assertAnalysis(fixture.dialect.analyze(probe.sql, fixture.snapshot), probe, `${fixture.name}.${probeName}`);
  }

  const capabilityNames = Object.keys(fixture.dialect.capabilities).sort();
  assert.deepStrictEqual(
    fixture.capabilities.map(({ capability }) => capability).sort(),
    capabilityNames,
    `${fixture.name} must provide exactly one probe for every declared capability`,
  );
  assert.strictEqual(new Set(fixture.capabilities.map(({ capability }) => capability)).size, capabilityNames.length);
  for (const capability of fixture.capabilities) {
    assert.strictEqual(fixture.dialect.capabilities[capability.capability], capability.supported);
    if (capability.supported) {
      assertAnalysis(
        fixture.dialect.analyze(capability.analysis.sql, fixture.snapshot),
        capability.analysis,
        `${fixture.name}.capability.${capability.capability}`,
      );
    } else {
      assertUnsupported(fixture, capability.unsupported, `${fixture.name}.capability.${capability.capability}`);
    }
  }

  assertUnsupported(fixture, fixture.unsupported, `${fixture.name}.unsupported`);

  if (fixture.policy !== undefined) {
    const policy = fixture.policy;
    const analysis = fixture.dialect.analyze(policy.sql, fixture.snapshot, policy.policy);
    assert.deepStrictEqual(analysis.diagnostics, []);
    assert.strictEqual(rowTypeLiteral(analysis.columns), policy.expectedRowType);
    if (policy.expectedParameterType !== undefined) {
      assert.strictEqual(
        parameterTypeLiteral(policy.parameterCount, analysis.parameters),
        policy.expectedParameterType,
      );
    }
  }

  const structural = compileSource({
    source: fixture.structural.source,
    dialect: fixture.dialect,
    schema: fixture.snapshot,
  });
  assert.deepStrictEqual(structural.diagnostics, [], `${fixture.name} structural diagnostics`);
  assert.strictEqual(structural.queries.length, 1, `${fixture.name} structural query count`);
  const compiled = structural.queries[0]!;
  assert.strictEqual(compiled.structural, true);
  assert.strictEqual(compiled.variantFingerprints.length, fixture.structural.expectedVariantCount);
  assert.strictEqual(new Set(compiled.variantFingerprints).size, fixture.structural.expectedVariantCount);
  assert.ok(compiled.fingerprint.startsWith("sha256:"));
  assert.strictEqual(compiled.rowType, fixture.structural.expectedRowType);
  assert.strictEqual(compiled.parameterType, fixture.structural.expectedParameterType);
  assertSemantics(
    compiled.semantics,
    fixture.structural.expectedSemantics,
    fixture.structural.source.length,
    `${fixture.name}.structural`,
  );

  return Object.freeze({
    version: GRAMMAR_CONFORMANCE_VERSION,
    grammar: fixture.dialect.id,
    grammarVersion: fixture.dialect.grammarVersion,
    requiredProbes: REQUIRED_GRAMMAR_PROBES,
    capabilities: Object.freeze({ ...fixture.dialect.capabilities }),
    structuralVariants: compiled.variantFingerprints.length,
  });
}

export function assertCodecConformance<Input, Output>(fixture: CodecConformanceFixture<Input, Output>): void {
  assert.ok(fixture.cases.length > 0, `${fixture.name} codec suite has no cases`);
  for (const testCase of fixture.cases) {
    assert.deepStrictEqual(fixture.decode(testCase.input), testCase.expected, `${fixture.name}.${testCase.name}`);
  }
}

export async function assertRuntimeAdapterConformance<Row, Parameters extends readonly unknown[]>(
  fixture: RuntimeAdapterConformanceFixture<Row, Parameters>,
): Promise<void> {
  const rendered = renderQuery(fixture.query, fixture.renderer);
  assert.strictEqual(rendered.text, fixture.expectedText, `${fixture.name} rendered SQL`);
  assert.deepStrictEqual(rendered.values, fixture.expectedValues, `${fixture.name} rendered values`);

  const calls: { readonly text: string; readonly values: readonly unknown[] }[] = [];
  const executor = {
    async execute(text: string, values: readonly unknown[]): Promise<readonly unknown[]> {
      calls.push({ text, values });
      return fixture.rows;
    },
  };
  const database = createDatabase(executor, fixture.renderer, async (run) => run(executor));
  assert.deepStrictEqual(await database.execute(fixture.query), fixture.rows, `${fixture.name} execution rows`);
  assert.deepStrictEqual(
    await database.transaction((transaction) => transaction.execute(fixture.query)),
    fixture.rows,
    `${fixture.name} transaction rows`,
  );
  assert.deepStrictEqual(calls, [rendered, rendered], `${fixture.name} adapter dispatch`);
}
