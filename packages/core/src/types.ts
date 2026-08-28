import type { QuerySemantics } from "./semantics.js";

export const DIALECT_CONTRACT_VERSION = 4 as const;

export interface SourceRange {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export interface SqlDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly range: SourceRange;
  readonly severity: "error" | "warning" | "info";
  readonly suggestion?: string;
  readonly fix?: SqlDiagnosticFix;
}

export interface SqlDiagnosticFix {
  readonly title: string;
  readonly range: SourceRange;
  readonly newText: string;
  readonly preferred?: boolean;
}

export interface ColumnSnapshot {
  readonly name: string;
  readonly databaseType: string;
  readonly tsType: string;
  readonly nullable: boolean;
  readonly array?: boolean;
  readonly defaultExpression?: string;
}

export interface TableSnapshot {
  readonly schema?: string;
  readonly name: string;
  readonly columns: Readonly<Record<string, ColumnSnapshot>>;
}

export interface DomainSnapshot {
  readonly name: string;
  readonly databaseType: string;
  readonly tsType: string;
  readonly nullable: boolean;
}

export interface FunctionSnapshot {
  readonly name: string;
  readonly schema?: string;
  readonly argumentTypes: readonly string[];
  readonly databaseReturnType?: string;
  readonly returnType: string;
  readonly nullable: boolean;
  readonly setReturning?: boolean;
  readonly volatility?: "immutable" | "stable" | "volatile";
}

export interface SchemaSnapshot {
  readonly formatVersion: 1;
  readonly dialect: string;
  readonly dialectVersion?: string;
  readonly version?: string;
  readonly tables: Readonly<Record<string, TableSnapshot>>;
  readonly enums?: Readonly<Record<string, readonly string[]>>;
  readonly domains?: Readonly<Record<string, DomainSnapshot>>;
  readonly functions?: Readonly<Record<string, FunctionSnapshot>>;
}

export interface GeneratedSchemaMetadata {
  readonly generatorVersion: string;
  readonly schemaHash: string;
  readonly typePolicyHash: string;
}

export interface GeneratedSchemaSnapshot extends SchemaSnapshot {
  readonly metadata: GeneratedSchemaMetadata;
}

export interface ResolvedColumn {
  readonly name: string;
  readonly tsType: string;
  readonly nullable: boolean;
  readonly databaseType?: string;
  readonly range: SourceRange;
}

export interface ResolvedParameter {
  /** One-based database placeholder index. */
  readonly index: number;
  readonly tsType: string;
  readonly nullable: boolean;
  readonly databaseType?: string;
}

export interface DialectAnalysis {
  readonly columns: readonly ResolvedColumn[];
  readonly parameters: readonly ResolvedParameter[];
  readonly diagnostics: readonly SqlDiagnostic[];
  readonly resultKind?: "rows" | "command";
  /** Grammar-owned, evidence-backed statement semantics. */
  readonly semantics: QuerySemantics;
}

/**
 * Grammar-owned feature declarations. Core intentionally does not assign meaning to the keys.
 * Tooling and applications can expose them without teaching neutral packages dialect semantics.
 */
export type DialectCapabilities = Readonly<Record<string, boolean>>;

export interface DialectPlugin<Snapshot extends SchemaSnapshot = SchemaSnapshot, Policy = unknown> {
  readonly contractVersion: typeof DIALECT_CONTRACT_VERSION;
  readonly id: string;
  /** Version of the grammar/snapshot semantics, independent of the npm artifact version. */
  readonly grammarVersion: string;
  /** Exact package entrypoint from which applications import the dialect's `sql` tag. */
  readonly sqlModule: string;
  /** Grammar-owned feature names and their support status. */
  readonly capabilities: DialectCapabilities;
  readonly defaultTypePolicy: Policy;
  placeholder(index: number): string;
  quoteIdentifier(identifier: string): string;
  analyze(sql: string, snapshot: Snapshot, policy?: Policy): DialectAnalysis;
  validateSnapshot(value: unknown): Snapshot;
}

export interface SchemaProvider<Snapshot extends SchemaSnapshot = SchemaSnapshot> {
  introspect(): Promise<Snapshot>;
}

export interface LiveQueryVerificationField {
  readonly index: number;
  readonly name?: string;
  readonly databaseType?: string;
  readonly tsType?: string;
  /** `undefined` means that the native protocol does not expose nullability. */
  readonly nullable?: boolean;
}

export interface LiveQueryVerificationRequest {
  readonly fingerprint: string;
  /** Compiler-owned SQL. Adapters must never persist or include it in errors or proof artifacts. */
  readonly sql: string;
  readonly operation: QuerySemantics["operation"]["value"];
}

export interface LiveQueryVerificationEvidence {
  readonly columns: readonly LiveQueryVerificationField[];
  readonly parameters: readonly LiveQueryVerificationField[];
  /** Native metadata classes unavailable on this server/driver combination. */
  readonly unavailable?: readonly ("columns" | "parameters")[];
}

export interface LiveQueryVerificationServer {
  readonly version: string;
  /** Sorted, non-secret server features that affect native analysis, such as installed extensions. */
  readonly features?: readonly string[];
}

/** Grammar-owned adapter over a database's native prepare/describe protocol. */
export interface LiveQueryVerifier {
  readonly dialect: string;
  readonly adapterVersion: string;
  server(): Promise<LiveQueryVerificationServer>;
  verify(request: LiveQueryVerificationRequest): Promise<LiveQueryVerificationEvidence>;
  close(): Promise<void>;
}

export interface QueryPlanEnvironment {
  readonly version: string;
  /** Sorted, non-secret optimizer settings that materially affect planning. */
  readonly settings: Readonly<Record<string, string>>;
  /** Adapter-produced identity for catalog statistics, never raw statistic values. */
  readonly statisticsFingerprint: string;
}

export interface QueryPlanNode {
  readonly kind: string;
  readonly relation?: string;
  readonly index?: string;
  readonly estimatedRows?: number;
  readonly estimatedCost?: number;
}

export interface QueryPlanEvidence {
  readonly totalCost?: number;
  readonly estimatedRows?: number;
  /** Pre-order, grammar-normalized node inventory. Expressions and sample values are excluded. */
  readonly nodes: readonly QueryPlanNode[];
}

export interface QueryPlanCaptureRequest {
  readonly fingerprint: string;
  /** Compiler-owned SQL. Adapters must never persist it or include it in errors or artifacts. */
  readonly sql: string;
  readonly operation: QuerySemantics["operation"]["value"];
  readonly parameterCount: number;
  /** Optional application-supplied planning samples. They are transient and never enter artifacts. */
  readonly values?: readonly unknown[];
}

/** Grammar-owned adapter over a database's structured, non-executing plan protocol. */
export interface QueryPlanInspector {
  readonly dialect: string;
  readonly adapterVersion: string;
  readonly parameterMode: "value-free" | "samples-required";
  environment(): Promise<QueryPlanEnvironment>;
  capture(request: QueryPlanCaptureRequest): Promise<QueryPlanEvidence>;
  close(): Promise<void>;
}

export interface QueryPlanSampleRequest {
  readonly queryId: string;
  readonly variantFingerprint: string;
  readonly source: { readonly file: string; readonly range: SourceRange };
  readonly parameters: readonly {
    readonly index: number;
    readonly databaseType?: string;
    readonly tsType: string;
    readonly nullable: boolean;
  }[];
}

export interface QueryPlanSample {
  /** Stable, non-secret identity used to make two sample-dependent plans comparable. */
  readonly identity: string;
  readonly values: readonly unknown[];
}

export type QueryPlanSampleProvider = (
  request: QueryPlanSampleRequest,
) => QueryPlanSample | undefined | Promise<QueryPlanSample | undefined>;

export interface QueryPlanBudget {
  readonly maximumTotalCost?: number;
  readonly maximumEstimatedRows?: number;
  readonly maximumTotalCostIncreaseRatio?: number;
  readonly maximumEstimatedRowsIncreaseRatio?: number;
  readonly requiredNodeKinds?: readonly string[];
  readonly forbiddenNodeKinds?: readonly string[];
}

export interface QueryPlanBudgetPolicy {
  readonly defaults?: QueryPlanBudget;
  readonly queries?: Readonly<Record<string, QueryPlanBudget>>;
}

export interface TypedSqlConfig<Snapshot extends SchemaSnapshot = SchemaSnapshot, Policy = unknown> {
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly schema: {
    readonly file: string;
    readonly provider?: SchemaProvider<Snapshot>;
  };
  readonly outDir: string;
  readonly projects?: readonly string[];
  readonly typePolicy?: Policy;
  readonly compiler?: {
    readonly maxStructuralVariants?: number;
  };
  readonly manifest?: {
    /** Output path relative to the typed-sql config file. */
    readonly outFile?: string;
  };
  readonly verification?: {
    /** Optional and lazy: ordinary compilation never opens a database connection. */
    readonly live?: LiveQueryVerifier;
    /** Proof path relative to the typed-sql config file. */
    readonly proofFile?: string;
    readonly concurrency?: number;
  };
  readonly compatibility?: {
    /** Report path relative to the typed-sql config file. */
    readonly reportFile?: string;
    /** Lowest severity that makes `typed-sql compat` fail. */
    readonly failOn?: "none" | "warning" | "error";
  };
  readonly plans?: {
    /** Optional and lazy: capture never occurs during inference, checking, or manifest generation. */
    readonly live?: QueryPlanInspector;
    readonly sampleValues?: QueryPlanSampleProvider;
    readonly artifactFile?: string;
    readonly reportFile?: string;
    readonly baselineFile?: string;
    readonly concurrency?: number;
    readonly budgets?: QueryPlanBudgetPolicy;
    readonly failOn?: "none" | "violation" | "uncertainty";
  };
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertQueryPlanBudget(value: QueryPlanBudget, description: string): void {
  for (const property of ["maximumTotalCost", "maximumEstimatedRows"] as const) {
    const maximum = value[property];
    if (maximum !== undefined && (!Number.isFinite(maximum) || maximum < 0)) {
      throw new TypeError(`${description}.${property} must be a non-negative finite number`);
    }
  }
  for (const property of ["maximumTotalCostIncreaseRatio", "maximumEstimatedRowsIncreaseRatio"] as const) {
    const ratio = value[property];
    if (ratio !== undefined && (!Number.isFinite(ratio) || ratio < 1)) {
      throw new TypeError(`${description}.${property} must be a finite number greater than or equal to 1`);
    }
  }
  for (const property of ["requiredNodeKinds", "forbiddenNodeKinds"] as const) {
    const kinds = value[property];
    if (kinds?.some((kind) => typeof kind !== "string" || kind.length === 0)) {
      throw new TypeError(`${description}.${property} must contain non-empty strings`);
    }
  }
}

export function assertDialectPlugin(value: unknown): asserts value is DialectPlugin {
  if (!record(value)) throw new TypeError("typed-sql dialect must be an object");
  if (value.contractVersion !== DIALECT_CONTRACT_VERSION) {
    throw new TypeError(`Unsupported typed-sql dialect contract ${String(value.contractVersion)}`);
  }
  for (const property of ["id", "grammarVersion", "sqlModule"] as const) {
    if (typeof value[property] !== "string" || value[property].length === 0) {
      throw new TypeError(`typed-sql dialect.${property} must be a non-empty string`);
    }
  }
  if (!("defaultTypePolicy" in value)) throw new TypeError("typed-sql dialect.defaultTypePolicy is required");
  if (
    !record(value.capabilities) ||
    Object.values(value.capabilities).some((supported) => typeof supported !== "boolean")
  ) {
    throw new TypeError("typed-sql dialect.capabilities must contain only boolean feature declarations");
  }
  for (const method of ["placeholder", "quoteIdentifier", "analyze", "validateSnapshot"] as const) {
    if (typeof value[method] !== "function") throw new TypeError(`typed-sql dialect.${method} must be a function`);
  }
}

export function defineConfig<Snapshot extends SchemaSnapshot, Policy>(
  config: TypedSqlConfig<Snapshot, Policy>,
): TypedSqlConfig<Snapshot, Policy> {
  assertDialectPlugin(config.dialect);
  const maximum = config.compiler?.maxStructuralVariants;
  if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 1)) {
    throw new TypeError("compiler.maxStructuralVariants must be a positive safe integer");
  }
  if (config.manifest?.outFile !== undefined && config.manifest.outFile.length === 0) {
    throw new TypeError("manifest.outFile must be a non-empty string");
  }
  if (
    config.verification?.proofFile !== undefined &&
    (typeof config.verification.proofFile !== "string" || config.verification.proofFile.length === 0)
  ) {
    throw new TypeError("verification.proofFile must be a non-empty string");
  }
  const concurrency = config.verification?.concurrency;
  if (concurrency !== undefined && (!Number.isSafeInteger(concurrency) || concurrency < 1)) {
    throw new TypeError("verification.concurrency must be a positive safe integer");
  }
  if (config.verification?.live !== undefined && config.verification.live.dialect !== config.dialect.id) {
    throw new TypeError(
      `verification.live dialect ${config.verification.live.dialect} does not match ${config.dialect.id}`,
    );
  }
  const live = config.verification?.live;
  if (live !== undefined) {
    if (typeof live.adapterVersion !== "string" || live.adapterVersion.length === 0) {
      throw new TypeError("verification.live.adapterVersion must be a non-empty string");
    }
    for (const method of ["server", "verify", "close"] as const) {
      if (typeof live[method] !== "function") throw new TypeError(`verification.live.${method} must be a function`);
    }
  }
  if (
    config.compatibility?.reportFile !== undefined &&
    (typeof config.compatibility.reportFile !== "string" || config.compatibility.reportFile.length === 0)
  ) {
    throw new TypeError("compatibility.reportFile must be a non-empty string");
  }
  if (
    config.compatibility?.failOn !== undefined &&
    !(["none", "warning", "error"] as const).includes(config.compatibility.failOn)
  ) {
    throw new TypeError("compatibility.failOn must be none, warning, or error");
  }
  for (const property of ["artifactFile", "reportFile", "baselineFile"] as const) {
    const path = config.plans?.[property];
    if (path !== undefined && (typeof path !== "string" || path.length === 0)) {
      throw new TypeError(`plans.${property} must be a non-empty string`);
    }
  }
  const planConcurrency = config.plans?.concurrency;
  if (planConcurrency !== undefined && (!Number.isSafeInteger(planConcurrency) || planConcurrency < 1)) {
    throw new TypeError("plans.concurrency must be a positive safe integer");
  }
  if (
    config.plans?.failOn !== undefined &&
    !(["none", "violation", "uncertainty"] as const).includes(config.plans.failOn)
  ) {
    throw new TypeError("plans.failOn must be none, violation, or uncertainty");
  }
  if (config.plans?.sampleValues !== undefined && typeof config.plans.sampleValues !== "function") {
    throw new TypeError("plans.sampleValues must be a function");
  }
  const inspector = config.plans?.live;
  if (inspector !== undefined) {
    if (inspector.dialect !== config.dialect.id) {
      throw new TypeError(`plans.live dialect ${inspector.dialect} does not match ${config.dialect.id}`);
    }
    if (typeof inspector.adapterVersion !== "string" || inspector.adapterVersion.length === 0) {
      throw new TypeError("plans.live.adapterVersion must be a non-empty string");
    }
    if (!(inspector.parameterMode === "value-free" || inspector.parameterMode === "samples-required")) {
      throw new TypeError("plans.live.parameterMode must be value-free or samples-required");
    }
    for (const method of ["environment", "capture", "close"] as const) {
      if (typeof inspector[method] !== "function") throw new TypeError(`plans.live.${method} must be a function`);
    }
  }
  if (config.plans?.budgets?.defaults !== undefined) {
    assertQueryPlanBudget(config.plans.budgets.defaults, "plans.budgets.defaults");
  }
  for (const [fingerprint, budget] of Object.entries(config.plans?.budgets?.queries ?? {})) {
    if (!/^sha256:[a-f\d]{64}$/u.test(fingerprint)) {
      throw new TypeError("plans.budgets.queries keys must be SHA-256 query fingerprints");
    }
    assertQueryPlanBudget(budget, `plans.budgets.queries.${fingerprint}`);
  }
  return Object.freeze(config);
}

export function rowTypeLiteral(columns: readonly ResolvedColumn[]): string {
  const properties = columns.map(
    (column) => `${JSON.stringify(column.name)}: ${column.tsType}${column.nullable ? " | null" : ""};`,
  );
  return `{ ${properties.join(" ")} }`;
}

export function parameterTypeLiteral(parameterCount: number, parameters: readonly ResolvedParameter[]): string {
  const byIndex = new Map(parameters.map((parameter) => [parameter.index, parameter]));
  const elements = Array.from({ length: parameterCount }, (_, offset) => {
    const parameter = byIndex.get(offset + 1);
    if (!parameter) return "unknown";
    if (parameter.tsType === "unknown") return "unknown";
    return `${parameter.tsType}${parameter.nullable ? " | null" : ""}`;
  });
  return `readonly [${elements.join(", ")}]`;
}
