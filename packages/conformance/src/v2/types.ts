import type {
  DialectPlugin,
  SchemaSnapshot,
  SourceRange,
  SqlDiagnostic,
  SqlRenderer,
  SqlSegment,
} from "@typed-sql/core";

export const CONFORMANCE_VERSION = 2 as const;
export const CONFORMANCE_REPORT_FORMAT_VERSION = 1 as const;

export type ConformanceSupport = "exact" | "conservative" | "unsupported" | "version-gated";
export type ConformanceLayer = "lex-parse" | "resolve" | "compile" | "render" | "prepare" | "execute" | "plan";
export type ConformanceLayerStatus = "pass" | "fail" | "skip";
export type ConformanceSkipReason =
  | "grammar-parser-private"
  | "no-compiler-source"
  | "no-runtime-query"
  | "no-live-adapter"
  | "no-server-metadata"
  | "execution-not-meaningful"
  | "plan-format-unstable";

export interface ConformanceTarget {
  readonly grammar: string;
  readonly grammarVersion: string;
  readonly databaseVersion?: string;
  readonly capabilities?: Readonly<Record<string, string | number | boolean>>;
}

export interface ConformanceTargetSelector {
  readonly grammarVersion?: string;
  readonly databaseVersion?: string;
  readonly minimumDatabaseVersion?: string;
  readonly maximumDatabaseVersion?: string;
  readonly capabilities?: Readonly<Record<string, string | number | boolean>>;
}

export interface ExpectedColumn {
  readonly name: string;
  readonly tsType: string;
  readonly nullable: boolean;
  readonly databaseType?: string;
  readonly range?: SourceRange;
}

export interface ExpectedParameter {
  readonly index: number;
  readonly tsType: string;
  readonly nullable: boolean;
  readonly databaseType?: string;
}

export interface ExpectedDiagnostic {
  readonly code: string;
  readonly severity: SqlDiagnostic["severity"];
  readonly range: SourceRange;
}

export interface ExpectedRenderedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
  readonly fingerprint?: string;
}

export interface ExpectedCompileResult {
  readonly rowType: string;
  readonly parameterType: string;
  readonly fingerprint?: string;
}

export interface ExpectedOutcome {
  readonly target: ConformanceTargetSelector;
  readonly support: ConformanceSupport;
  readonly rows?: readonly ExpectedColumn[];
  readonly parameters?: readonly ExpectedParameter[];
  readonly diagnostics?: readonly ExpectedDiagnostic[];
  readonly rendered?: ExpectedRenderedQuery;
  readonly compiled?: ExpectedCompileResult;
  readonly decodedRows?: readonly unknown[];
  readonly plan?: unknown;
  readonly resultKind?: "rows" | "command";
  readonly skips?: Partial<Readonly<Record<ConformanceLayer, ConformanceSkipReason>>>;
}

export interface LiveProbePolicy {
  readonly prepare?: boolean;
  readonly execute?: boolean;
  readonly plan?: boolean;
  readonly allowMutation?: boolean;
  readonly allowMultipleStatements?: boolean;
  readonly maximumRows?: number;
  readonly timeoutMilliseconds?: number;
}

export interface ConformanceProbe {
  readonly version: typeof CONFORMANCE_VERSION;
  readonly id: string;
  readonly featureId: string;
  readonly grammar: string;
  readonly targets: readonly ConformanceTarget[];
  readonly source: string;
  readonly schemaFixture: string;
  readonly expected: readonly ExpectedOutcome[];
  readonly query?: { readonly segments: readonly SqlSegment[] };
  readonly compilerSource?: string;
  readonly live?: LiveProbePolicy;
  readonly quarantine?: { readonly owner: string; readonly issue: string; readonly expires: string };
}

export interface ConformanceSuite {
  readonly version: typeof CONFORMANCE_VERSION;
  readonly name: string;
  readonly probes: readonly ConformanceProbe[];
}

export interface ConformanceParserResult {
  readonly diagnostics: readonly SqlDiagnostic[];
  readonly ast?: unknown;
}

export interface ConformanceStaticContext<Snapshot extends SchemaSnapshot, Policy = unknown> {
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly snapshot: Snapshot;
  readonly renderer: SqlRenderer;
  readonly policy?: Policy;
  readonly parse?: (source: string) => ConformanceParserResult;
}

export interface ConformanceEnvironment {
  readonly grammar: string;
  readonly grammarVersion: string;
  readonly databaseVersion?: string;
  readonly driver?: string;
  readonly driverVersion?: string;
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly typescriptVersion?: string;
  readonly schemaFingerprint: string;
  readonly capabilities: Readonly<Record<string, string | number | boolean>>;
}

export interface ConformanceDifference {
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

export interface ConformanceLayerResult {
  readonly layer: ConformanceLayer;
  readonly status: ConformanceLayerStatus;
  readonly durationMilliseconds: number;
  readonly skipReason?: ConformanceSkipReason;
  readonly differences?: readonly ConformanceDifference[];
  readonly errorClass?: ConformanceServerErrorClass;
}

export interface ConformanceProbeResult {
  readonly probeId: string;
  readonly featureId: string;
  readonly target: ConformanceTarget;
  readonly support: ConformanceSupport;
  readonly status: "pass" | "fail" | "skip" | "quarantined";
  readonly layers: readonly ConformanceLayerResult[];
}

export interface ConformanceReport {
  readonly formatVersion: typeof CONFORMANCE_REPORT_FORMAT_VERSION;
  readonly conformanceVersion: typeof CONFORMANCE_VERSION;
  readonly generatedAt: string;
  readonly suite: string;
  readonly environment: ConformanceEnvironment;
  readonly results: readonly ConformanceProbeResult[];
  readonly summary: {
    readonly pass: number;
    readonly fail: number;
    readonly skip: number;
    readonly quarantined: number;
    readonly exactEligible: number;
  };
}

export type ConformanceServerErrorClass = "syntax" | "semantic" | "schema" | "privilege" | "environment" | "timeout";

export interface ConformanceNativeField {
  readonly index: number;
  readonly name?: string;
  readonly nativeType?: string;
  readonly nullable?: boolean;
}

export interface ConformancePreparedEvidence {
  readonly columns: readonly ConformanceNativeField[];
  readonly parameters: readonly ConformanceNativeField[];
  readonly unavailable?: readonly ("columns" | "parameters" | "nullability")[];
}

export interface ConformanceLiveRequest {
  readonly probeId: string;
  readonly sql: string;
  readonly values: readonly unknown[];
  readonly timeoutMilliseconds: number;
}

export interface ConformanceLiveAdapter {
  readonly grammar: string;
  readonly driver: string;
  readonly driverVersion: string;
  server(): Promise<{
    readonly version: string;
    readonly capabilities: Readonly<Record<string, string | number | boolean>>;
  }>;
  prepare(request: ConformanceLiveRequest): Promise<ConformancePreparedEvidence>;
  execute(request: ConformanceLiveRequest): Promise<readonly unknown[]>;
  plan?(request: ConformanceLiveRequest): Promise<unknown>;
  classify(error: unknown): ConformanceServerErrorClass;
  cleanup(probeId: string): Promise<void>;
  close(): Promise<void>;
}

export interface ConformanceTypeNormalizer {
  column(field: ConformanceNativeField): Omit<ExpectedColumn, "range">;
  parameter(field: ConformanceNativeField): ExpectedParameter;
}

export interface ConformanceReproductionBundle {
  readonly formatVersion: 1;
  readonly probeId: string;
  readonly featureId: string;
  readonly source: string;
  readonly schemaFixture: string;
  readonly target: ConformanceTarget;
  readonly environment: ConformanceEnvironment;
  readonly expected: ExpectedOutcome;
  readonly actual: ConformanceProbeResult;
  readonly command: string;
}
