import { describe, it, strict } from "poku";
import type { AuditGrammar } from "../../scripts/language-audit/grammars/contracts.js";
import { createAuditGrammarRegistry } from "../../scripts/language-audit/grammars/registry.js";
import { serialize } from "../../scripts/language-audit/inventory.mjs";
import { planInvocationShapes } from "../../scripts/language-audit/invocation-shapes.js";
import { auditInvocationShapes } from "../../scripts/language-audit/shape-audit.js";
import { createMapperRegistry } from "../../tools/grammar-catalog/src/registry.mjs";

const mapper = {
  id: "vendor/base",
  versionBand: (version: string) => version,
  normalizeRow: (_category: string, row: unknown) => row,
  namespacePolicy: "global",
  parameterMode: (mode: string) => ({ input: "input", named: "named-only" })[mode] ?? "unknown",
  routineFacts: () => ({
    parameters: [
      { position: 1, inputPosition: 1, name: "left", nativeType: "node", mode: "input", hasDefault: false },
      { position: 2, inputPosition: 2, name: "right", nativeType: "node", mode: "input", hasDefault: false },
      { position: null, inputPosition: null, name: "depth", nativeType: "integer", mode: "named", hasDefault: null },
    ],
    result: "node",
    variadic: false,
  }),
};
const base: AuditGrammar = {
  id: mapper.id,
  versionBand: (version) => version,
  tokenize: () => [],
  planEntity: () => undefined,
  planInvocations: () => [],
  invocationShapeSyntax: {
    call: (row, args) => `GRAPH ${row.name}(${args.join(",")})`,
    named: (name, value) => `${name}=${value}`,
    value: () => "NODE",
    rejection: () => "binding",
  },
  createAnalysis: () => ({
    names: new Set(),
    analyze: (sql) => ({
      columns: [
        {
          name: "value",
          tsType: "GraphNode",
          databaseType: "node",
          nullable: false,
          range: { start: 0, end: sql.length, line: 1, column: 1 },
        },
      ],
      parameters: [],
      diagnostics: [],
    }),
  }),
};
const mappers = createMapperRegistry([mapper]).extend([{ id: "vendor/graph", extends: mapper.id }]);
const registry = createAuditGrammarRegistry([base]).extend([{ id: "vendor/graph", extends: base.id }]);
const row = { name: "node", kind: "scalar" };

await describe("generated native invocation shapes", async () => {
  await it("derives arity, names, order and option cases from inherited formal metadata", () => {
    const plan = planInvocationShapes(
      row,
      mappers.get("vendor/graph"),
      registry.get("vendor/graph").invocationShapeSyntax!,
    );
    strict.deepEqual(plan.gaps, []);
    strict.equal(plan.routine.parameters.status, "known");
    for (const kind of [
      "positional-control",
      "omit-trailing-argument",
      "append-argument",
      "named-control",
      "unknown-argument-name",
      "reverse-named-arguments",
      "duplicate-argument-name",
      "positional-after-named",
      "named-option-control",
      "unknown-option-name",
    ])
      strict.ok(
        plan.cases.some((probe) => probe.kind === kind),
        kind,
      );
    for (const probe of plan.cases)
      if (probe.control)
        strict.ok(plan.cases.some((control) => control.id === probe.control && control.role === "control"));
    strict.ok(plan.cases.every((probe) => probe.sql.startsWith("GRAPH node(")));
  });
  await it("detects native-rejected typed mutations only after accepting the same-expression control", async () => {
    const report = await auditInvocationShapes(
      "vendor/graph",
      "2",
      [row],
      async (sql) => ({ accepted: !sql.includes("typed_sql_audit_unknown") }),
      undefined,
      { registry, mappers },
    );
    strict.equal(report.failures, 2);
    strict.equal(report.counts["native-rejected-host-typed"], 2);
    strict.equal(report.entities[0]?.routine?.parameters.status, "known");
    strict.deepEqual(JSON.parse(serialize(report)), report);
    const rejected = await auditInvocationShapes(
      "vendor/graph",
      "2",
      [row],
      async () => ({ accepted: false }),
      undefined,
      { registry, mappers },
    );
    strict.equal(rejected.failures, 0);
    strict.ok(rejected.entities[0]!.gaps.some((gap) => gap.startsWith("native-control-rejected:")));
    strict.equal(rejected.counts["native-rejected-host-typed"], undefined);
  });
  await it("uses retained driver details to classify a rejection without replacing the stable error code", async () => {
    const descriptions = registry.extend([
      {
        id: "vendor/details",
        extends: "vendor/graph",
        invocationShapeSyntax: {
          ...base.invocationShapeSyntax!,
          rejection: (reason) => (reason.includes("binding detail") ? "binding" : "unclassified"),
        },
      },
    ]);
    const mappings = mappers.extend([{ id: "vendor/details", extends: "vendor/graph" }]);
    const report = await auditInvocationShapes(
      "vendor/details",
      "2",
      [row],
      async (sql) => ({
        accepted: !sql.includes("typed_sql_audit_unknown"),
        reason: "STABLE_CODE",
        detail: "binding detail",
      }),
      undefined,
      { registry: descriptions, mappers: mappings },
    );
    strict.equal(report.failures, 2);
    strict.deepEqual(JSON.parse(serialize(report)), report);
    strict.ok(
      Object.values(report.observations).some((observation) => {
        const native = (observation as { native?: { reason?: string; detail?: string } }).native;
        return native?.reason === "STABLE_CODE" && native.detail === "binding detail";
      }),
    );
  });
  await it("records unavailable parameter evidence and owner syntax without fabricating slots", async () => {
    const unknown = mappers.extend([
      { id: "vendor/no-formals", extends: "vendor/graph", routineFacts: () => ({ parameters: null }) },
    ]);
    const inherited = registry.extend([{ id: "vendor/no-formals", extends: "vendor/graph" }]);
    const report = await auditInvocationShapes(
      "vendor/no-formals",
      "2",
      [row],
      async () => {
        throw new Error("must not prepare unavailable metadata");
      },
      undefined,
      { registry: inherited, mappers: unknown },
    );
    strict.deepEqual(report.entities[0]?.gaps, ["formal-parameters-unavailable"]);
    strict.equal(report.uniqueStatements, 0);
    const { invocationShapeSyntax: _syntax, ...without } = base;
    const fallback = await auditInvocationShapes(mapper.id, "2", [row], async () => ({ accepted: true }), undefined, {
      registry: createAuditGrammarRegistry([without]),
      mappers,
    });
    strict.deepEqual(fallback.entities[0]?.gaps, ["registered-owner-has-no-shape-syntax"]);
    strict.deepEqual(JSON.parse(serialize(fallback)), fallback);
  });
  await it("retains host crashes but propagates unexpected native transport failures", async () => {
    const crashing = registry.extend([
      {
        id: "vendor/crash",
        extends: "vendor/graph",
        createAnalysis: () => ({
          names: new Set(),
          analyze: () => {
            throw new Error("host crash");
          },
        }),
      },
    ]);
    const mapped = mappers.extend([{ id: "vendor/crash", extends: "vendor/graph" }]);
    const report = await auditInvocationShapes(
      "vendor/crash",
      "2",
      [row],
      async () => ({ accepted: true }),
      undefined,
      { registry: crashing, mappers: mapped },
    );
    strict.ok(report.failures > 0);
    strict.equal(report.counts["grammar-analysis-failure"], report.failures);
    await strict.rejects(
      auditInvocationShapes(
        "vendor/graph",
        "2",
        [row],
        async () => {
          throw new Error("transport unavailable");
        },
        undefined,
        { registry, mappers },
      ),
      /transport unavailable/u,
    );
  });
});
