import type {
  DialectCapabilityStates,
  DialectPlugin,
  Query,
  QueryCardinality,
  QueryConnectionAffinity,
  QueryDependencyAccess,
  QueryDependencyKind,
  QueryLocking,
  QueryOperation,
  QueryVolatility,
  SchemaSnapshot,
  SqlRenderer,
} from "@typed-sql/core";

/** @deprecated Use `CONFORMANCE_VERSION` from `@typed-sql/conformance/v2`. Removed in typed-sql 3.0. */
export const GRAMMAR_CONFORMANCE_VERSION = 1 as const;

export const REQUIRED_GRAMMAR_PROBES = Object.freeze([
  "select",
  "parameters",
  "nullability",
  "joins",
  "ctes",
  "functions",
  "dml",
] as const);

export type RequiredGrammarProbe = (typeof REQUIRED_GRAMMAR_PROBES)[number];

export interface GrammarDependencyExpectation {
  readonly kind: QueryDependencyKind;
  readonly access: QueryDependencyAccess;
  readonly name: string;
  readonly schema?: string;
  readonly parent?: string;
}

export interface GrammarSemanticExpectation {
  readonly operation: QueryOperation;
  readonly volatility: QueryVolatility;
  readonly locking?: QueryLocking;
  readonly connectionAffinity?: QueryConnectionAffinity;
  readonly cardinalityMinimum?: QueryCardinality["minimum"];
  readonly cardinalityMaximum: QueryCardinality["maximum"];
  readonly dependencies?: readonly GrammarDependencyExpectation[];
  readonly capabilities?: readonly string[];
}

export interface GrammarAnalysisProbe {
  readonly sql: string;
  readonly parameterCount: number;
  readonly expectedRowType: string;
  readonly expectedParameterType: string;
  readonly expectedResultKind: "rows" | "command";
  readonly expectedSemantics: GrammarSemanticExpectation;
  readonly expectedDiagnosticCodes?: readonly string[];
}

export interface GrammarUnsupportedProbe {
  readonly sql: string;
  readonly diagnosticCode: string;
}

export type GrammarCapabilityProbe =
  | {
      readonly capability: string;
      readonly supported: true;
      readonly analysis: GrammarAnalysisProbe;
    }
  | {
      readonly capability: string;
      readonly supported: false;
      readonly unsupported: GrammarUnsupportedProbe;
    };

export interface GrammarStructuralProbe {
  readonly source: string;
  readonly expectedVariantCount: number;
  readonly expectedRowType: string;
  readonly expectedParameterType: string;
  readonly expectedSemantics: GrammarSemanticExpectation;
}

export interface GrammarPolicyProbe<Policy> {
  readonly sql: string;
  readonly policy: Policy;
  readonly parameterCount: number;
  readonly expectedRowType: string;
  readonly expectedParameterType?: string;
}

export interface GrammarConformanceFixture<Snapshot extends SchemaSnapshot, Policy> {
  readonly version: typeof GRAMMAR_CONFORMANCE_VERSION;
  readonly name: string;
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly renderer: SqlRenderer;
  readonly snapshot: Snapshot;
  readonly placeholderTwo: string;
  readonly identifier: string;
  readonly quotedIdentifier: string;
  readonly probes: Readonly<Record<RequiredGrammarProbe, GrammarAnalysisProbe>>;
  readonly capabilities: readonly GrammarCapabilityProbe[];
  readonly unsupported: GrammarUnsupportedProbe;
  readonly structural: GrammarStructuralProbe;
  readonly policy?: GrammarPolicyProbe<Policy>;
}

export interface GrammarConformanceReport {
  readonly version: typeof GRAMMAR_CONFORMANCE_VERSION;
  readonly grammar: string;
  readonly grammarVersion: string;
  readonly requiredProbes: readonly RequiredGrammarProbe[];
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly capabilityStates: DialectCapabilityStates;
  readonly structuralVariants: number;
}

export interface VersionedCapabilityExpectation {
  readonly capability: string;
  readonly level: "exact" | "conservative" | "unsupported";
  readonly diagnostic?: string;
  readonly evidenceKinds?: readonly ("server-version" | "feature" | "setting" | "policy" | "grammar")[];
}

export interface VersionedCapabilityProbe<Snapshot, Policy = unknown> {
  readonly name: string;
  readonly snapshot: Snapshot;
  readonly policy?: Policy;
  readonly expected: readonly VersionedCapabilityExpectation[];
}

export interface VersionedCapabilityConformanceFixture<Snapshot extends SchemaSnapshot, Policy = unknown> {
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly probes: readonly VersionedCapabilityProbe<Snapshot, Policy>[];
}

export interface CodecConformanceCase<Input, Output> {
  readonly name: string;
  readonly input: Input;
  readonly expected: Output;
}

export interface CodecConformanceFixture<Input, Output> {
  readonly name: string;
  readonly decode: (input: Input) => Output;
  readonly cases: readonly CodecConformanceCase<Input, Output>[];
}

export interface RuntimeAdapterConformanceFixture<Row, Parameters extends readonly unknown[]> {
  readonly name: string;
  readonly renderer: SqlRenderer;
  readonly query: Query<Row, Parameters>;
  readonly expectedText: string;
  readonly expectedValues: readonly unknown[];
  readonly rows: readonly Row[];
}

export interface GrammarPerformanceOptions<Snapshot extends SchemaSnapshot, Policy> {
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly snapshot: Snapshot;
  readonly queries: readonly string[];
  readonly policy?: Policy;
  readonly warmups?: number;
  readonly samples?: number;
}

export interface GrammarPerformanceResult {
  readonly queryCount: number;
  readonly warmups: number;
  readonly samples: number;
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly minimumQueriesPerSecond: number;
}
