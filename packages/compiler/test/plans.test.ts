import { describe, it, strict } from "poku";
import type { QueryPlanInspector } from "../../core/src/index.js";
import { type PostgresSchemaSnapshot, postgres } from "../../postgres/src/index.js";
import {
  buildQueryManifest,
  captureQueryPlans,
  collectQueryVerificationCandidates,
  parseQueryPlanArtifact,
  parseQueryPlanReviewReport,
  reviewQueryPlans,
  serializeQueryPlanArtifact,
  serializeQueryPlanReviewReport,
} from "../src/index.js";

const rootDir = "/portable/project";
const file = `${rootDir}/src/queries.ts`;
const snapshot: PostgresSchemaSnapshot = {
  formatVersion: 1,
  dialect: "postgres",
  tables: {
    users: {
      name: "users",
      columns: {
        id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
        email: { name: "email", databaseType: "text", tsType: "string", nullable: false },
      },
    },
  },
};
const source = [
  'import { sql } from "@typed-sql/postgres";',
  "declare const id: bigint; declare const email: string;",
  "export const read = sql`SELECT users.id, users.email FROM users WHERE users.id = ${id}`;",
  "export const write = sql`UPDATE users SET email = ${email} WHERE id = ${id}`;",
  'export const dynamic = sql.dynamic("SELECT runtime");',
].join("\n");
const dialect = postgres();
const manifest = buildQueryManifest({
  rootDir,
  sources: [{ file, source }],
  dialect,
  schema: snapshot,
  compilerVersion: "test",
}).manifest;
const candidates = collectQueryVerificationCandidates({
  manifest,
  rootDir,
  sources: [{ file, source }],
  dialect,
  schema: snapshot,
});

function inspector(overrides: Partial<QueryPlanInspector> = {}): QueryPlanInspector {
  return {
    dialect: "postgres",
    adapterVersion: "fake-explain-v1",
    parameterMode: "value-free",
    async environment() {
      return {
        version: "18.4",
        settings: { z_setting: "off", a_setting: "on" },
        statisticsFingerprint: `sha256:${"a".repeat(64)}`,
      };
    },
    async capture(request) {
      return {
        totalCost: request.operation === "write" ? 20 : 10,
        estimatedRows: 2,
        nodes: [{ kind: "Index Scan", relation: "users", index: "users_pkey", estimatedRows: 2 }],
      };
    },
    async close() {},
    ...overrides,
  };
}

await describe("query plan governance", async () => {
  await it("captures canonical redacted plans without persisting SQL or samples", async () => {
    const seen: unknown[][] = [];
    const result = await captureQueryPlans({
      manifest,
      candidates,
      inspector: inspector({
        async capture(request) {
          seen.push([...(request.values ?? [])]);
          return { totalCost: 10, estimatedRows: 2, nodes: [{ kind: "Index Scan", relation: "users" }] };
        },
      }),
      async sampleValues(request) {
        return {
          identity: `representative-${request.parameters.length}`,
          values: request.parameters.map((parameter) => (parameter.tsType === "bigint" ? 42n : "private@example.com")),
        };
      },
      concurrency: 2,
    });
    strict.strictEqual(result.captured, 2);
    strict.strictEqual(result.skipped, 1);
    strict.strictEqual(result.failed, 0);
    strict.strictEqual(seen.length, 2);
    const serialized = serializeQueryPlanArtifact(result.artifact);
    strict.strictEqual(serialized, serializeQueryPlanArtifact(result.artifact));
    strict.ok(!serialized.includes("SELECT"));
    strict.ok(!serialized.includes("private@example.com"));
    strict.ok(!serialized.includes("representative-"));
    strict.ok(!serialized.includes(rootDir));
    strict.ok(serialized.indexOf("a_setting") < serialized.indexOf("z_setting"));
    strict.strictEqual(parseQueryPlanArtifact(JSON.parse(serialized)).captureKey, result.artifact.captureKey);
  });

  await it("makes missing, invalid, and failed samples explicit without leaking failures", async () => {
    const required = inspector({
      parameterMode: "samples-required",
      async capture() {
        throw new Error("recognizable-secret");
      },
    });
    const missing = await captureQueryPlans({ manifest, candidates, inspector: required });
    strict.strictEqual(missing.captured, 0);
    strict.strictEqual(missing.skipped, 3);

    const mismatched = await captureQueryPlans({
      manifest,
      candidates,
      inspector: required,
      sampleValues: () => ({ identity: "wrong-count", values: [] }),
    });
    strict.ok(
      mismatched.artifact.entries.some(
        (entry) => entry.status === "skipped" && entry.reason === "sample-count-mismatch",
      ),
    );

    const failed = await captureQueryPlans({
      manifest,
      candidates,
      inspector: required,
      sampleValues: (request) => ({ identity: "valid", values: request.parameters.map(() => 1) }),
    });
    strict.strictEqual(failed.failed, 2);
    strict.ok(!serializeQueryPlanArtifact(failed.artifact).includes("recognizable-secret"));
    strict.strictEqual(
      parseQueryPlanArtifact(JSON.parse(serializeQueryPlanArtifact(failed.artifact))).entries[0]?.status,
      "error",
    );

    const providerFailure = await captureQueryPlans({
      manifest,
      candidates,
      inspector: inspector(),
      sampleValues() {
        throw new Error("private-value");
      },
    });
    strict.strictEqual(providerFailure.failed, 2);
    strict.ok(!serializeQueryPlanArtifact(providerFailure.artifact).includes("private-value"));
  });

  await it("enforces absolute and comparable delta budgets while separating uncertainty", async () => {
    const baseline = await captureQueryPlans({ manifest, candidates, inspector: inspector() });
    const current = await captureQueryPlans({
      manifest,
      candidates,
      inspector: inspector({
        async capture() {
          return {
            totalCost: 25,
            estimatedRows: 20,
            nodes: [{ kind: "Seq Scan", relation: "users", estimatedRows: 20 }],
          };
        },
      }),
    });
    const report = reviewQueryPlans({
      current: current.artifact,
      baseline: baseline.artifact,
      budgets: {
        defaults: {
          maximumTotalCost: 20,
          maximumEstimatedRows: 10,
          maximumTotalCostIncreaseRatio: 2,
          maximumEstimatedRowsIncreaseRatio: 5,
          requiredNodeKinds: ["Index Scan"],
          forbiddenNodeKinds: ["Seq Scan"],
        },
      },
    });
    strict.strictEqual(report.summary.violation, 2);
    const violations = new Set(report.entries.flatMap((entry) => entry.violations.map((item) => item.kind)));
    for (const kind of [
      "total-cost",
      "estimated-rows",
      "total-cost-increase",
      "estimated-rows-increase",
      "required-node-missing",
      "forbidden-node-present",
    ] as const) {
      strict.ok(violations.has(kind), `Missing ${kind}`);
    }

    const changedEnvironment = {
      ...current.artifact,
      environment: { ...current.artifact.environment, version: "19.0" },
    };
    const recalculated = await captureQueryPlans({
      manifest,
      candidates,
      inspector: inspector({
        async environment() {
          return { ...changedEnvironment.environment };
        },
      }),
    });
    const uncertain = reviewQueryPlans({
      current: recalculated.artifact,
      baseline: baseline.artifact,
      budgets: { defaults: { maximumTotalCostIncreaseRatio: 1.1 } },
    });
    strict.strictEqual(uncertain.summary.incomparable, 2);
    strict.ok(uncertain.environmentReasons.includes("server-version-changed"));
    const parsedReport = parseQueryPlanReviewReport(JSON.parse(serializeQueryPlanReviewReport(report)));
    strict.deepStrictEqual(parsedReport.summary, report.summary);
  });

  await it("classifies missing, unavailable, changed-sample, and unbudgeted baselines", async () => {
    const first = await captureQueryPlans({
      manifest,
      candidates,
      inspector: inspector(),
      sampleValues: (request) => ({ identity: "first", values: request.parameters.map(() => 1) }),
    });
    const second = await captureQueryPlans({
      manifest,
      candidates,
      inspector: inspector(),
      sampleValues: (request) => ({ identity: "second", values: request.parameters.map(() => 1) }),
    });
    const sampleChanged = reviewQueryPlans({
      current: second.artifact,
      baseline: first.artifact,
      budgets: { defaults: { maximumTotalCostIncreaseRatio: 2 } },
    });
    strict.ok(sampleChanged.entries.some((entry) => entry.reasons.includes("sample-changed")));

    const captured = first.artifact.entries.filter((entry) => entry.status === "captured");
    const missing = reviewQueryPlans({
      current: second.artifact,
      baseline: { ...first.artifact, entries: [] },
      budgets: { defaults: { maximumTotalCostIncreaseRatio: 2 } },
    });
    strict.ok(missing.entries.some((entry) => entry.reasons.includes("baseline-query-missing")));
    const unavailable = reviewQueryPlans({
      current: second.artifact,
      baseline: {
        ...first.artifact,
        entries: captured.map((entry) => ({
          ...entry,
          status: "skipped" as const,
          reason: "unsafe-operation" as const,
        })),
      },
      budgets: { defaults: { maximumTotalCostIncreaseRatio: 2 } },
    });
    strict.ok(unavailable.entries.some((entry) => entry.reasons.includes("baseline-query-unavailable")));
    strict.strictEqual(reviewQueryPlans({ current: first.artifact }).summary.unbudgeted, 2);
  });

  await it("validates capture boundaries and preserves every explicit skip class", async () => {
    for (const [overrides, message] of [
      [{ dialect: "mysql" }, /does not match/u],
      [{ adapterVersion: "" }, /adapterVersion/u],
      [{ parameterMode: "unsupported" }, /parameterMode/u],
    ] as const) {
      await strict.rejects(
        captureQueryPlans({ manifest, candidates, inspector: inspector(overrides as never) }),
        message,
      );
    }
    await strict.rejects(
      captureQueryPlans({ manifest, candidates, inspector: inspector(), concurrency: 0 }),
      /concurrency/u,
    );
    await strict.rejects(
      captureQueryPlans({
        manifest,
        candidates,
        inspector: inspector({
          async environment() {
            return { version: "", settings: {}, statisticsFingerprint: "bad" };
          },
        }),
      }),
      /version/u,
    );
    await strict.rejects(
      captureQueryPlans({
        manifest,
        candidates,
        inspector: inspector(),
        sampleValues: (request) => ({ identity: "", values: request.parameters.map(() => 1) }),
      }),
      /identity/u,
    );
    const absent = await captureQueryPlans({ manifest, candidates: [], inspector: inspector() });
    strict.ok(
      absent.artifact.entries.some((entry) => entry.status === "skipped" && entry.reason === "candidate-missing"),
    );
    const unsafe = await captureQueryPlans({
      manifest,
      candidates: candidates.map((candidate) => ({ ...candidate, operation: "transaction-control" as never })),
      inspector: inspector(),
    });
    strict.ok(
      unsafe.artifact.entries.some((entry) => entry.status === "skipped" && entry.reason === "unsafe-operation"),
    );
  });

  await it("rejects stale or tampered public artifacts", async () => {
    const result = await captureQueryPlans({ manifest, candidates, inspector: inspector() });
    strict.throws(
      () => parseQueryPlanArtifact({ ...result.artifact, captureKey: `sha256:${"f".repeat(64)}` }),
      /canonical evidence/u,
    );
    strict.throws(() => parseQueryPlanArtifact({ formatVersion: 99 }), /Unsupported/u);
    for (const invalid of [
      null,
      { ...result.artifact, captureVersion: "future" },
      { ...result.artifact, adapterVersion: "" },
      { ...result.artifact, parameterMode: "other" },
      { ...result.artifact, manifestHash: "bad" },
      { ...result.artifact, schemaFormat: 3 },
      { ...result.artifact, schemaHash: "bad" },
      { ...result.artifact, environment: null },
      { ...result.artifact, entries: null },
      { ...result.artifact, entries: [null] },
      { ...result.artifact, entries: [{ ...result.artifact.entries[0], queryId: "bad" }] },
      {
        ...result.artifact,
        entries: [
          { ...result.artifact.entries[0], source: { ...result.artifact.entries[0]!.source, file: "/absolute" } },
        ],
      },
      { ...result.artifact, entries: [{ ...result.artifact.entries[0], status: "other" }] },
    ]) {
      strict.throws(() => parseQueryPlanArtifact(invalid));
    }

    const report = reviewQueryPlans({ current: result.artifact, budgets: { defaults: { maximumTotalCost: 100 } } });
    const serialized = JSON.parse(serializeQueryPlanReviewReport(report)) as Record<string, unknown>;
    strict.throws(() => parseQueryPlanReviewReport(null));
    strict.throws(() => parseQueryPlanReviewReport({ ...serialized, formatVersion: 2 }), /Unsupported/u);
    strict.throws(() => parseQueryPlanReviewReport({ ...serialized, captureKey: "bad" }), /fingerprint/u);
    strict.throws(() => parseQueryPlanReviewReport({ ...serialized, entries: null }), /invalid/u);
    strict.throws(() => parseQueryPlanReviewReport({ ...serialized, entries: [null] }), /entry 0/u);
    strict.throws(
      () => parseQueryPlanReviewReport({ ...serialized, summary: { ...(serialized.summary as object), pass: 99 } }),
      /summary\.pass/u,
    );
  });
});
