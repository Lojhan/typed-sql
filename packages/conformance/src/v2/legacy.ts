import type { SchemaSnapshot } from "@typed-sql/core";
import type { GrammarAnalysisProbe, GrammarConformanceFixture, RequiredGrammarProbe } from "../types.js";
import { defineConformanceProbe, defineConformanceSuite } from "./contracts.js";
import { runStaticConformanceProbe } from "./runner.js";
import {
  CONFORMANCE_VERSION,
  type ConformanceProbe,
  type ConformanceProbeResult,
  type ConformanceSuite,
  type ConformanceTarget,
  type ExpectedOutcome,
} from "./types.js";

const legacyFeatures: Readonly<Record<RequiredGrammarProbe, string>> = Object.freeze({
  select: "statement.select",
  parameters: "expression.operator",
  nullability: "resolver.catalog",
  joins: "query.join",
  ctes: "query.cte",
  functions: "expression.function.call",
  dml: "statement.update",
});

function expectedOutcome<Snapshot extends SchemaSnapshot, Policy>(
  fixture: GrammarConformanceFixture<Snapshot, Policy>,
  probe: GrammarAnalysisProbe,
): ExpectedOutcome {
  const analysis = fixture.dialect.analyze(probe.sql, fixture.snapshot);
  return {
    target: { grammarVersion: fixture.dialect.grammarVersion },
    support: "exact",
    rows: analysis.columns.map(({ name, tsType, nullable, databaseType, range }) => ({
      name,
      tsType,
      nullable,
      ...(databaseType === undefined ? {} : { databaseType }),
      range,
    })),
    parameters: analysis.parameters.map(({ index, tsType, nullable, databaseType }) => ({
      index,
      tsType,
      nullable,
      ...(databaseType === undefined ? {} : { databaseType }),
    })),
    diagnostics: analysis.diagnostics.map(({ code, severity, range }) => ({ code, severity, range })),
    resultKind: analysis.resultKind ?? "rows",
    skips: {
      "lex-parse": "grammar-parser-private",
      compile: "no-compiler-source",
      render: "no-runtime-query",
      prepare: "no-live-adapter",
      execute: "no-live-adapter",
      plan: "no-live-adapter",
    },
  };
}

export function adaptGrammarConformanceV1<Snapshot extends SchemaSnapshot, Policy>(
  fixture: GrammarConformanceFixture<Snapshot, Policy>,
): ConformanceSuite {
  const target: ConformanceTarget = Object.freeze({
    grammar: fixture.dialect.id,
    grammarVersion: fixture.dialect.grammarVersion,
  });
  const probes = Object.entries(fixture.probes).map(([name, probe]) => {
    const requiredName = name as RequiredGrammarProbe;
    return defineConformanceProbe({
      version: CONFORMANCE_VERSION,
      id: `${fixture.dialect.id}.legacy.${name}`,
      featureId: legacyFeatures[requiredName],
      grammar: fixture.dialect.id,
      targets: [target],
      source: probe.sql,
      schemaFixture: `legacy/${fixture.dialect.id}/schema.json`,
      expected: [expectedOutcome(fixture, probe)],
    });
  });
  return defineConformanceSuite({ version: CONFORMANCE_VERSION, name: `${fixture.name}-legacy-v2`, probes });
}

export function runAdaptedGrammarConformanceV1<Snapshot extends SchemaSnapshot, Policy>(
  fixture: GrammarConformanceFixture<Snapshot, Policy>,
): readonly ConformanceProbeResult[] {
  const suite = adaptGrammarConformanceV1(fixture);
  const target: ConformanceTarget = Object.freeze({
    grammar: fixture.dialect.id,
    grammarVersion: fixture.dialect.grammarVersion,
  });
  return Object.freeze(
    suite.probes.map((probe: ConformanceProbe) =>
      runStaticConformanceProbe(probe, target, {
        dialect: fixture.dialect,
        snapshot: fixture.snapshot,
        renderer: fixture.renderer,
      }),
    ),
  );
}
