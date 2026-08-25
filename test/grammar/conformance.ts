import { strict as assert } from "node:assert";
import { compileSource } from "../../packages/compiler/src/index.js";
import {
  assertDialectPlugin,
  type DialectPlugin,
  defineConfig,
  parameterTypeLiteral,
  rowTypeLiteral,
  type SchemaSnapshot,
  type SqlRenderer,
} from "../../packages/core/src/index.js";

export interface DialectConformanceFixture<Snapshot extends SchemaSnapshot, Policy> {
  readonly name: string;
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly renderer: SqlRenderer;
  readonly snapshot: Snapshot;
  readonly placeholderTwo: string;
  readonly identifier: string;
  readonly quotedIdentifier: string;
  readonly expectedCapabilities: Readonly<Record<string, boolean>>;
  readonly query: string;
  readonly expectedRowType: string;
  readonly expectedParameterType: string;
  readonly unsupportedQuery: string;
  readonly unsupportedCode: string;
  readonly policyProbe?: {
    readonly query: string;
    readonly policy: Policy;
    readonly expectedRowType: string;
  };
}

export function assertDialectConformance<Snapshot extends SchemaSnapshot, Policy>(
  fixture: DialectConformanceFixture<Snapshot, Policy>,
): void {
  const { dialect, snapshot } = fixture;
  assertDialectPlugin(dialect);
  assert.doesNotThrow(() =>
    defineConfig({
      dialect,
      schema: { file: "schema.json" },
      outDir: "generated",
      typePolicy: dialect.defaultTypePolicy,
    }),
  );
  assert.deepStrictEqual(dialect.capabilities, fixture.expectedCapabilities);
  assert.ok(Object.values(dialect.capabilities).every((supported) => typeof supported === "boolean"));
  assert.strictEqual(dialect.placeholder(2), fixture.placeholderTwo);
  assert.strictEqual(dialect.placeholder(2), fixture.renderer.placeholder(2));
  assert.throws(() => dialect.placeholder(0));
  assert.strictEqual(dialect.quoteIdentifier(fixture.identifier), fixture.quotedIdentifier);
  assert.strictEqual(dialect.quoteIdentifier(fixture.identifier), fixture.renderer.quoteIdentifier(fixture.identifier));
  assert.strictEqual(dialect.validateSnapshot(snapshot).dialect, dialect.id);
  assert.throws(() => dialect.validateSnapshot({ ...snapshot, dialect: `${dialect.id}-other` }));
  assert.throws(() => dialect.validateSnapshot({ ...snapshot, dialectVersion: "incompatible" }));

  const resolved = dialect.analyze(fixture.query, snapshot);
  assert.deepStrictEqual(
    resolved.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
    `${fixture.name} rejected its conformance query`,
  );
  assert.strictEqual(rowTypeLiteral(resolved.columns), fixture.expectedRowType);
  assert.strictEqual(parameterTypeLiteral(1, resolved.parameters), fixture.expectedParameterType);

  if (fixture.policyProbe !== undefined) {
    const policyResult = dialect.analyze(fixture.policyProbe.query, snapshot, fixture.policyProbe.policy);
    assert.deepStrictEqual(policyResult.diagnostics, []);
    assert.strictEqual(rowTypeLiteral(policyResult.columns), fixture.policyProbe.expectedRowType);
  }

  const unsupported = dialect.analyze(fixture.unsupportedQuery, snapshot);
  assert.ok(
    unsupported.diagnostics.some(({ code, severity }) => code === fixture.unsupportedCode && severity === "error"),
  );
  const source = [
    `import { sql } from ${JSON.stringify(dialect.sqlModule)};`,
    "const query = sql`",
    fixture.unsupportedQuery,
    "`;",
  ].join("\n");
  const compiled = compileSource({ source, dialect, schema: snapshot });
  assert.strictEqual(compiled.queries.length, 0, `${fixture.name} optimistically typed unsupported SQL`);
  assert.ok(compiled.diagnostics.some(({ code }) => code === fixture.unsupportedCode));
}
