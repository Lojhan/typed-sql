import { DIALECT_CONTRACT_VERSION, type DialectPlugin, sql, unknownQuerySemantics } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import {
  assertExactConformance,
  CONFORMANCE_VERSION,
  type ConformanceEnvironment,
  type ConformanceLiveAdapter,
  type ConformanceNativeField,
  type ConformanceProbe,
  type ConformanceServerErrorClass,
  type ConformanceTarget,
  type ConformanceTypeNormalizer,
  createConformanceReport,
  createConformanceReproductionBundle,
  defineConformanceProbe,
  defineConformanceSuite,
  discoverConformanceFixtures,
  formatConformanceReport,
  minimizeConformanceSource,
  runLiveConformanceProbe,
  runStaticConformanceProbe,
  selectExpectedOutcome,
  serializeConformanceReport,
  serializeConformanceReproductionBundle,
  targetMatches,
} from "../src/v2/index.js";

const source = "SELECT value FROM widgets WHERE value = $1";
const range = Object.freeze({ start: 7, end: 12, line: 1, column: 8 });
const snapshot = Object.freeze({
  formatVersion: 1 as const,
  dialect: "synthetic",
  dialectVersion: "1.0.0",
  tables: Object.freeze({
    widgets: Object.freeze({
      name: "widgets",
      columns: Object.freeze({
        value: Object.freeze({
          name: "value",
          databaseType: "int8",
          tsType: "bigint",
          nullable: false,
        }),
      }),
    }),
  }),
});

const dialect: DialectPlugin<typeof snapshot, Readonly<Record<string, never>>> = Object.freeze({
  contractVersion: DIALECT_CONTRACT_VERSION,
  id: "synthetic",
  grammarVersion: "1.0.0",
  sqlModule: "@typed-sql/synthetic",
  capabilities: Object.freeze({}),
  defaultTypePolicy: Object.freeze({}),
  placeholder: (index: number) => `$${index}`,
  quoteIdentifier: (identifier: string) => `"${identifier.replaceAll('"', '""')}"`,
  validateSnapshot(value: unknown) {
    if (value !== snapshot) throw new TypeError("wrong synthetic snapshot");
    return snapshot;
  },
  analyze(sqlSource: string) {
    if (sqlSource !== source) {
      return Object.freeze({
        columns: Object.freeze([]),
        parameters: Object.freeze([]),
        diagnostics: Object.freeze([]),
        semantics: unknownQuerySemantics(
          Object.freeze({ start: 0, end: sqlSource.length, line: 1, column: 1 }),
          "test input",
        ),
      });
    }
    return Object.freeze({
      columns: Object.freeze([
        Object.freeze({ name: "value", tsType: "bigint", nullable: false, databaseType: "int8", range }),
      ]),
      parameters: Object.freeze([Object.freeze({ index: 1, tsType: "bigint", nullable: false, databaseType: "int8" })]),
      diagnostics: Object.freeze([]),
      resultKind: "rows" as const,
      semantics: unknownQuerySemantics(Object.freeze({ start: 0, end: sqlSource.length, line: 1, column: 1 }), "test"),
    });
  },
});

const renderer = Object.freeze({
  placeholder: (index: number) => `$${index}`,
  quoteIdentifier: (identifier: string) => `"${identifier.replaceAll('"', '""')}"`,
});
const target: ConformanceTarget = Object.freeze({
  grammar: "synthetic",
  grammarVersion: "1.0.0",
  databaseVersion: "2.4.0",
  capabilities: Object.freeze({ preparedMetadata: true }),
});

function exactProbe(overrides: Partial<ConformanceProbe> = {}): ConformanceProbe {
  return defineConformanceProbe({
    version: CONFORMANCE_VERSION,
    id: "statement.select.ordered-parameter",
    featureId: "statement.select",
    grammar: "synthetic",
    targets: [target],
    source,
    schemaFixture: "packages/conformance/fixtures/shared/statement.select/schema.json",
    query: sql`SELECT value FROM widgets WHERE value = ${1n}`,
    compilerSource:
      'import { sql } from "@typed-sql/synthetic";\nexport const query = sql`SELECT value FROM widgets WHERE value = ${1n}`;',
    live: Object.freeze({ prepare: true, execute: true, plan: true, maximumRows: 1 }),
    expected: [
      {
        target: {
          grammarVersion: "1.0.0",
          minimumDatabaseVersion: "2.0.0",
          maximumDatabaseVersion: "2.9.0",
          capabilities: { preparedMetadata: true },
        },
        support: "exact",
        rows: [{ name: "value", tsType: "bigint", nullable: false, databaseType: "int8", range }],
        parameters: [{ index: 1, tsType: "bigint", nullable: false, databaseType: "int8" }],
        diagnostics: [],
        rendered: { text: source, values: [1n] },
        compiled: { rowType: '{ "value": bigint; }', parameterType: "readonly [bigint]" },
        decodedRows: [{ value: 1n }],
        plan: { kind: "scan" },
      },
    ],
    ...overrides,
  });
}

class LiveAdapter implements ConformanceLiveAdapter {
  readonly grammar = "synthetic";
  readonly driver = "synthetic-driver";
  readonly driverVersion = "1.2.3";
  readonly cleaned: string[] = [];
  rows: readonly unknown[] = [{ value: 1n }];
  executionError: unknown;
  cleanupError: unknown;
  errorClass: ConformanceServerErrorClass = "semantic";
  preparedColumns: readonly ConformanceNativeField[] = [
    { index: 1, name: "value", nativeType: "INT8", nullable: false },
  ];

  async server() {
    return { version: "2.4.0", capabilities: Object.freeze({ preparedMetadata: true }) };
  }

  async prepare() {
    return {
      columns: this.preparedColumns,
      parameters: [{ index: 1, nativeType: "INT8", nullable: false }],
    };
  }

  async execute() {
    if (this.executionError !== undefined) throw this.executionError;
    return this.rows;
  }

  async plan() {
    return { kind: "scan" };
  }

  classify(_error: unknown): ConformanceServerErrorClass {
    return this.errorClass;
  }

  async cleanup(probeId: string) {
    if (this.cleanupError !== undefined) throw this.cleanupError;
    this.cleaned.push(probeId);
  }

  async close() {}
}

const normalizer: ConformanceTypeNormalizer = Object.freeze({
  column(field: ConformanceNativeField) {
    return {
      name: field.name ?? `column_${field.index}`,
      tsType: "bigint",
      nullable: field.nullable ?? true,
      databaseType: "int8",
    };
  },
  parameter(field: ConformanceNativeField) {
    return { index: field.index, tsType: "bigint", nullable: field.nullable ?? true, databaseType: "int8" };
  },
});

const environment: ConformanceEnvironment = Object.freeze({
  grammar: "synthetic",
  grammarVersion: "1.0.0",
  databaseVersion: "2.4.0",
  driver: "synthetic-driver",
  driverVersion: "1.2.3",
  runtime: "node",
  runtimeVersion: process.version,
  typescriptVersion: "7.0.0-dev",
  schemaFingerprint: `sha256:${"a".repeat(64)}`,
  capabilities: Object.freeze({ preparedMetadata: true }),
});

await describe("conformance v2", async () => {
  await it("validates permanent probes, selectors, and immutable suites", () => {
    const probe = exactProbe();
    const suite = defineConformanceSuite({ version: CONFORMANCE_VERSION, name: "synthetic", probes: [probe] });
    strict.ok(Object.isFrozen(suite));
    strict.ok(Object.isFrozen(suite.probes[0]?.expected[0]?.rows));
    strict.strictEqual(selectExpectedOutcome(probe, target).support, "exact");
    strict.strictEqual(targetMatches({ minimumDatabaseVersion: "2.3.0" }, target), true);
    strict.strictEqual(targetMatches({ databaseVersion: "2.5.0" }, target), false);
    strict.throws(() => defineConformanceSuite({ ...suite, probes: [probe, probe] }), /unique/u);
    strict.throws(() => exactProbe({ id: "invalid" }), /Invalid conformance probe/u);
    strict.throws(
      () =>
        exactProbe({ expected: [{ target: { databaseVersion: "2", minimumDatabaseVersion: "1" }, support: "exact" }] }),
      /cannot combine/u,
    );
    strict.throws(() => exactProbe({ quarantine: { owner: "team", issue: "#1", expires: "2020-01-01" } }), /expired/u);
  });

  await it("aggregates static and live layers into exact evidence", async () => {
    const probe = exactProbe();
    const staticResult = runStaticConformanceProbe(probe, target, {
      dialect,
      snapshot,
      renderer,
      parse: () => ({ diagnostics: [], ast: Object.freeze({ kind: "select" }) }),
    });
    strict.deepStrictEqual(
      staticResult.layers.map(({ layer, status }) => [layer, status]),
      [
        ["lex-parse", "pass"],
        ["resolve", "pass"],
        ["compile", "pass"],
        ["render", "pass"],
        ["prepare", "skip"],
        ["execute", "skip"],
        ["plan", "skip"],
      ],
    );

    const adapter = new LiveAdapter();
    const result = await runLiveConformanceProbe(probe, target, adapter, normalizer, staticResult);
    strict.strictEqual(result.status, "pass");
    strict.deepStrictEqual(
      result.layers.map(({ status }) => status),
      Array.from({ length: 7 }, () => "pass"),
    );
    strict.deepStrictEqual(adapter.cleaned, [probe.id]);

    const report = createConformanceReport("synthetic", environment, [result], new Date("2026-08-31T00:00:00Z"));
    strict.deepStrictEqual(report.summary, { pass: 1, fail: 0, skip: 0, quarantined: 0, exactEligible: 1 });
    strict.doesNotThrow(() => assertExactConformance(report));
    strict.match(serializeConformanceReport(report), /"exactEligible": 1/u);
    strict.match(formatConformanceReport(report), /1 passed/u);
    strict.ok(Object.isFrozen(report.results));
  });

  await it("reports mismatches, blocks incomplete exact claims, and redacts reproductions", async () => {
    const probe = exactProbe();
    const staticResult = runStaticConformanceProbe(probe, target, {
      dialect,
      snapshot,
      renderer,
      parse: () => ({ diagnostics: [], ast: Object.freeze({ kind: "select" }) }),
    });
    const adapter = new LiveAdapter();
    adapter.rows = [{ value: 2n }];
    const result = await runLiveConformanceProbe(probe, target, adapter, normalizer, staticResult);
    strict.strictEqual(result.status, "fail");
    const report = createConformanceReport("synthetic", environment, [result]);
    strict.throws(() => assertExactConformance(report), /ordered-parameter/u);

    const expected = selectExpectedOutcome(probe, target);
    const bundle = createConformanceReproductionBundle(probe, target, environment, expected, result);
    strict.deepStrictEqual(bundle.expected.rendered?.values, ["[redacted]"]);
    strict.match(bundle.command, /--probe statement\.select\.ordered-parameter/u);
    strict.ok(!serializeConformanceReproductionBundle(bundle).includes("1n"));
  });

  await it("enforces safe live execution before invoking an adapter", async () => {
    const adapter = new LiveAdapter();
    const multiple = exactProbe({ source: "SELECT 1; SELECT 2" });
    await strict.rejects(() => runLiveConformanceProbe(multiple, target, adapter, normalizer), /multiple/u);
    const mutation = exactProbe({ source: "DELETE FROM widgets" });
    await strict.rejects(() => runLiveConformanceProbe(mutation, target, adapter, normalizer), /allow live mutation/u);
    strict.deepStrictEqual(adapter.cleaned, []);
  });

  await it("classifies timeouts, connection loss, malformed metadata, and cleanup failures", async () => {
    const staticResult = runStaticConformanceProbe(exactProbe(), target, {
      dialect,
      snapshot,
      renderer,
      parse: () => ({ diagnostics: [], ast: Object.freeze({ kind: "select" }) }),
    });

    const timeoutAdapter = new LiveAdapter();
    timeoutAdapter.execute = () => new Promise(() => undefined);
    const timeout = await runLiveConformanceProbe(
      exactProbe({ live: { prepare: true, execute: true, timeoutMilliseconds: 1 } }),
      target,
      timeoutAdapter,
      normalizer,
      staticResult,
    );
    strict.strictEqual(timeout.layers.find(({ layer }) => layer === "execute")?.errorClass, "timeout");

    const disconnected = new LiveAdapter();
    disconnected.executionError = new Error("connection lost: postgresql://user:secret@localhost/database");
    disconnected.errorClass = "environment";
    const connectionLoss = await runLiveConformanceProbe(exactProbe(), target, disconnected, normalizer, staticResult);
    strict.strictEqual(connectionLoss.layers.find(({ layer }) => layer === "execute")?.errorClass, "environment");
    strict.ok(
      !serializeConformanceReport(createConformanceReport("failure", environment, [connectionLoss])).includes("secret"),
    );

    const malformed = new LiveAdapter();
    malformed.preparedColumns = [{ index: 0, name: "value", nativeType: "INT8", nullable: false }];
    const malformedResult = await runLiveConformanceProbe(exactProbe(), target, malformed, normalizer, staticResult);
    strict.strictEqual(malformedResult.layers.find(({ layer }) => layer === "prepare")?.status, "fail");

    const cleanup = new LiveAdapter();
    cleanup.cleanupError = new Error("cleanup failed");
    await strict.rejects(
      () => runLiveConformanceProbe(exactProbe(), target, cleanup, normalizer, staticResult),
      /cleanup failed/u,
    );
  });

  await it("discovers deterministic fixtures and minimizes only while failure is preserved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-conformance-v2-"));
    try {
      await mkdir(join(directory, "nested"));
      const fixture = exactProbe({ query: undefined as never });
      const serializable = {
        ...fixture,
        query: undefined,
        expected: fixture.expected.map((value) => ({ ...value, rendered: undefined, decodedRows: undefined })),
      };
      await writeFile(join(directory, "nested", "select.probe.json"), `${JSON.stringify(serializable)}\n`);
      const discovered = await discoverConformanceFixtures(directory);
      strict.deepStrictEqual(
        discovered.probes.map(({ id }) => id),
        [fixture.id],
      );

      const minimized = await minimizeConformanceSource(
        exactProbe({ source: "SELECT redundant tokens FROM widgets" }),
        (candidate) => candidate.source.includes("SELECT") && candidate.source.includes("widgets"),
      );
      strict.strictEqual(minimized.source, "SELECT widgets");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
