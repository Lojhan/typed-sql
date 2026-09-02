import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  ARTIFACT_COMPATIBILITY_IDENTITY_FORMAT_VERSION,
  type ArtifactCompatibilityIdentity,
  assessArtifactCompatibility,
  CORE_ARTIFACT_COMPATIBILITY_VERSION,
  type DialectCapabilityState,
  type DialectCapabilityStates,
  type DialectPlugin,
  type QuerySemantics,
  type ResolvedColumn,
  type ResolvedParameter,
  resolveDialectCapabilityStates,
  type SchemaSnapshot,
  type SourceRange,
  type SqlDiagnostic,
} from "@typed-sql/core";
import { calculateSchemaHash, calculateTypePolicyHash } from "@typed-sql/schema";
import { compileSource } from "./compiler.js";
import { extractDynamicQueries, extractStaticQueries } from "./scanner.js";

export const QUERY_MANIFEST_FORMAT_VERSION = 1 as const;
export const QUERY_FINGERPRINT_ALGORITHM = "typed-sql-v1" as const;

export interface QueryManifestSourceInput {
  readonly file: string;
  readonly source: string;
}

export interface QueryManifestSource {
  readonly file: string;
  readonly hash: string;
}

export interface QueryManifestLocation {
  readonly file: string;
  readonly range: SourceRange;
}

export interface QueryManifestDiagnostic {
  readonly code: string;
  readonly severity: SqlDiagnostic["severity"];
  readonly range: SourceRange;
}

export interface QueryManifestSemanticEvidence {
  readonly kind: QuerySemantics["operation"]["evidence"][number]["kind"];
  readonly range: SourceRange;
}

export interface QueryManifestSemanticFact<Value extends string = string> {
  readonly value: Value;
  readonly evidence: readonly QueryManifestSemanticEvidence[];
}

export interface QueryManifestSemantics {
  readonly version: QuerySemantics["version"];
  readonly operation: QueryManifestSemanticFact<QuerySemantics["operation"]["value"]>;
  readonly dependencies: QuerySemantics["dependencies"];
  readonly cardinality: {
    readonly minimum: QuerySemantics["cardinality"]["minimum"];
    readonly maximum: QuerySemantics["cardinality"]["maximum"];
    readonly evidence: readonly QueryManifestSemanticEvidence[];
  };
  readonly volatility: QueryManifestSemanticFact<QuerySemantics["volatility"]["value"]>;
  readonly locking: QueryManifestSemanticFact<QuerySemantics["locking"]["value"]>;
  readonly connectionAffinity: QueryManifestSemanticFact<QuerySemantics["connectionAffinity"]["value"]>;
  readonly capabilities: readonly string[];
}

export interface QueryManifestColumn {
  readonly name: string;
  readonly tsType: string;
  readonly nullable: boolean;
  readonly databaseType?: string;
}

export interface QueryManifestParameter {
  readonly index: number;
  readonly tsType: string;
  readonly nullable: boolean;
  readonly databaseType?: string;
}

export interface QueryManifestVariant {
  readonly fingerprint: string;
  readonly choices: Readonly<Record<string, boolean>>;
  readonly rowType: string;
  readonly parameterType: string;
  readonly columns: readonly QueryManifestColumn[];
  readonly parameters: readonly QueryManifestParameter[];
  readonly semantics: QueryManifestSemantics;
  /** Evidence for declared dialect capabilities this variant actually uses. */
  readonly capabilityEvidence?: readonly QueryManifestCapabilityEvidence[];
}

export interface QueryManifestCapabilityEvidence extends DialectCapabilityState {
  readonly capability: string;
}

interface QueryManifestEntryBase {
  readonly id: string;
  readonly source: QueryManifestLocation;
}

export interface ResolvedQueryManifestEntry extends QueryManifestEntryBase {
  readonly status: "resolved";
  readonly structural: boolean;
  readonly fingerprint: string;
  readonly rowType: string;
  readonly parameterType: string;
  readonly diagnostics: readonly QueryManifestDiagnostic[];
  readonly variants: readonly QueryManifestVariant[];
  readonly semantics: QueryManifestSemantics;
  /** Evidence for declared dialect capabilities this query actually uses. */
  readonly capabilityEvidence?: readonly QueryManifestCapabilityEvidence[];
}

export interface UnresolvedQueryManifestEntry extends QueryManifestEntryBase {
  readonly status: "unresolved";
  readonly reason: "diagnostic" | "dynamic";
  readonly diagnostics: readonly QueryManifestDiagnostic[];
}

export type QueryManifestEntry = ResolvedQueryManifestEntry | UnresolvedQueryManifestEntry;

export interface QueryManifest {
  readonly formatVersion: typeof QUERY_MANIFEST_FORMAT_VERSION;
  readonly compilerVersion: string;
  readonly fingerprintAlgorithm: typeof QUERY_FINGERPRINT_ALGORITHM;
  readonly dialect: {
    readonly id: string;
    readonly grammarVersion: string;
    /** Hash of canonical grammar/server capability evidence used for this analysis. */
    readonly capabilityFingerprint?: string;
  };
  /** Schema contract used to produce this manifest; absent only on historical artifacts. */
  readonly schemaFormat?: 1 | 2;
  readonly schemaHash: string;
  readonly typePolicyHash: string;
  readonly projects: readonly string[];
  readonly sources: readonly QueryManifestSource[];
  readonly queries: readonly QueryManifestEntry[];
}

export interface BuildQueryManifestOptions<Snapshot extends SchemaSnapshot, Policy> {
  readonly rootDir: string;
  readonly sources: readonly QueryManifestSourceInput[];
  readonly projects?: readonly string[];
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly schema: Snapshot;
  readonly typePolicy?: Policy;
  readonly compilerVersion: string;
  readonly maxStructuralVariants?: number;
  readonly previous?: QueryManifest;
}

export interface QueryManifestBuildStats {
  readonly analyzedFiles: number;
  readonly reusedFiles: number;
  readonly resolvedQueries: number;
  readonly unresolvedQueries: number;
}

export interface BuildQueryManifestResult {
  readonly manifest: QueryManifest;
  readonly stats: QueryManifestBuildStats;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function portableRelative(rootDir: string, file: string): string {
  const root = resolve(rootDir);
  const path = relative(root, isAbsolute(file) ? resolve(file) : resolve(root, file))
    .split(sep)
    .join("/");
  if (path.length === 0 || isAbsolute(path)) throw new TypeError(`Cannot make ${file} relative to ${rootDir}`);
  return path;
}

function isPortableRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.startsWith("\\") &&
    !/^[A-Za-z]:[\\/]/u.test(path) &&
    !path.includes("\0")
  );
}

function columnDescription(column: ResolvedColumn): QueryManifestColumn {
  return {
    name: column.name,
    tsType: column.tsType,
    nullable: column.nullable,
    ...(column.databaseType === undefined ? {} : { databaseType: column.databaseType }),
  };
}

function parameterDescription(parameter: ResolvedParameter): QueryManifestParameter {
  return {
    index: parameter.index,
    tsType: parameter.tsType,
    nullable: parameter.nullable,
    ...(parameter.databaseType === undefined ? {} : { databaseType: parameter.databaseType }),
  };
}

function choiceDescriptions(choices: Readonly<Record<string, boolean>>): Readonly<Record<string, boolean>> {
  return Object.fromEntries(
    Object.entries(choices)
      .map(([condition, enabled]) => [`sha256:${sha256(condition)}`, enabled] as const)
      .sort(([left], [right]) => compareText(left, right)),
  );
}

function manifestDiagnostic(diagnostic: SqlDiagnostic): QueryManifestDiagnostic {
  return { code: diagnostic.code, severity: diagnostic.severity, range: diagnostic.range };
}

function manifestSemantics(semantics: QuerySemantics): QueryManifestSemantics {
  const evidence = (items: QuerySemantics["operation"]["evidence"]): readonly QueryManifestSemanticEvidence[] =>
    items.map((item) => ({ kind: item.kind, range: item.range }));
  const fact = <Value extends string>(value: {
    readonly value: Value;
    readonly evidence: QuerySemantics["operation"]["evidence"];
  }) => ({
    value: value.value,
    evidence: evidence(value.evidence),
  });
  return {
    version: semantics.version,
    operation: fact(semantics.operation),
    dependencies: semantics.dependencies,
    cardinality: { ...semantics.cardinality, evidence: evidence(semantics.cardinality.evidence) },
    volatility: fact(semantics.volatility),
    locking: fact(semantics.locking),
    connectionAffinity: fact(semantics.connectionAffinity),
    capabilities: semantics.capabilities,
  };
}

function manifestCapabilityEvidence(
  semantics: QuerySemantics,
  states: DialectCapabilityStates,
): readonly QueryManifestCapabilityEvidence[] {
  return [...new Set(semantics.capabilities)]
    .sort(compareText)
    .flatMap((capability): QueryManifestCapabilityEvidence[] => {
      const state = states[capability];
      return state === undefined ? [] : [{ capability, ...state }];
    });
}

function entryId(dialect: string, location: QueryManifestLocation, identity: string): string {
  return `sha256:${sha256(`${dialect}\0${location.file}\0${location.range.start}\0${identity}`)}`;
}

function inRange(diagnostic: SqlDiagnostic, range: SourceRange): boolean {
  return diagnostic.range.start >= range.start && diagnostic.range.start < range.end;
}

function sourceEntries<Snapshot extends SchemaSnapshot, Policy>(
  file: string,
  source: string,
  options: BuildQueryManifestOptions<Snapshot, Policy>,
  capabilityStates: DialectCapabilityStates,
): readonly QueryManifestEntry[] {
  const compilation = compileSource({
    source,
    dialect: options.dialect,
    schema: options.schema,
    ...(options.typePolicy === undefined ? {} : { typePolicy: options.typePolicy }),
    ...(options.maxStructuralVariants === undefined ? {} : { maxStructuralVariants: options.maxStructuralVariants }),
  });
  const extracted = extractStaticQueries(source, (index) => options.dialect.placeholder(index), [
    options.dialect.sqlModule,
  ]);
  const compiledByStart = new Map(compilation.queries.map((query) => [query.query.range.start, query]));
  const entries: QueryManifestEntry[] = extracted.map((query) => {
    const location = { file, range: query.range };
    const compiled = compiledByStart.get(query.range.start);
    if (compiled === undefined) {
      const diagnostics = compilation.diagnostics.filter((diagnostic) => inRange(diagnostic, query.range));
      return {
        id: entryId(options.dialect.id, location, `unresolved\0${query.sql}`),
        source: location,
        status: "unresolved",
        reason: "diagnostic",
        diagnostics: diagnostics.map(manifestDiagnostic),
      };
    }
    return {
      id: entryId(options.dialect.id, location, compiled.fingerprint),
      source: location,
      status: "resolved",
      structural: compiled.structural === true,
      fingerprint: compiled.fingerprint,
      rowType: compiled.rowType,
      parameterType: compiled.parameterType,
      diagnostics: compilation.diagnostics
        .filter((diagnostic) => inRange(diagnostic, query.range))
        .map(manifestDiagnostic),
      variants: compiled.variants.map((variant) => {
        const capabilityEvidence = manifestCapabilityEvidence(variant.semantics, capabilityStates);
        return {
          fingerprint: variant.fingerprint,
          choices: choiceDescriptions(variant.choices),
          rowType: variant.rowType,
          parameterType: variant.parameterType,
          columns: variant.columns.map(columnDescription),
          parameters: variant.parameters.map(parameterDescription),
          semantics: manifestSemantics(variant.semantics),
          ...(capabilityEvidence.length === 0 ? {} : { capabilityEvidence }),
        };
      }),
      semantics: manifestSemantics(compiled.semantics),
      ...(manifestCapabilityEvidence(compiled.semantics, capabilityStates).length === 0
        ? {}
        : { capabilityEvidence: manifestCapabilityEvidence(compiled.semantics, capabilityStates) }),
    };
  });
  for (const dynamic of extractDynamicQueries(source, [options.dialect.sqlModule])) {
    const location = { file, range: dynamic.range };
    entries.push({
      id: entryId(options.dialect.id, location, "dynamic"),
      source: location,
      status: "unresolved",
      reason: "dynamic",
      diagnostics: [
        {
          code: "TSQ005",
          severity: "info",
          range: dynamic.range,
        },
      ],
    });
  }
  return entries.sort((left, right) => left.source.range.start - right.source.range.start);
}

function compatiblePrevious(
  previous: QueryManifest | undefined,
  compilerVersion: string,
  dialect: Pick<DialectPlugin, "id" | "grammarVersion">,
  capabilityFingerprint: string,
  schemaFormat: 1 | 2,
  schemaHash: string,
  typePolicyHash: string,
): previous is QueryManifest {
  if (previous?.schemaFormat === undefined || previous.dialect.capabilityFingerprint === undefined) return false;
  const identity = (
    manifest: Pick<
      QueryManifest,
      "formatVersion" | "compilerVersion" | "fingerprintAlgorithm" | "schemaHash" | "typePolicyHash"
    > & {
      readonly dialect: {
        readonly id: string;
        readonly grammarVersion: string;
        readonly capabilityFingerprint: string;
      };
      readonly schemaFormat: 1 | 2;
    },
  ): ArtifactCompatibilityIdentity => ({
    formatVersion: ARTIFACT_COMPATIBILITY_IDENTITY_FORMAT_VERSION,
    artifact: {
      kind: "query-manifest",
      version: String(manifest.formatVersion),
      algorithm: manifest.fingerprintAlgorithm,
    },
    producer: { core: CORE_ARTIFACT_COMPATIBILITY_VERSION, compiler: manifest.compilerVersion },
    grammar: {
      id: manifest.dialect.id,
      version: manifest.dialect.grammarVersion,
      capabilityFingerprint: manifest.dialect.capabilityFingerprint,
    },
    schema: { formatVersion: manifest.schemaFormat, hash: manifest.schemaHash },
    typePolicyHash: manifest.typePolicyHash,
  });
  return (
    assessArtifactCompatibility(
      identity({
        formatVersion: QUERY_MANIFEST_FORMAT_VERSION,
        compilerVersion,
        fingerprintAlgorithm: QUERY_FINGERPRINT_ALGORITHM,
        dialect: { id: dialect.id, grammarVersion: dialect.grammarVersion, capabilityFingerprint },
        schemaFormat,
        schemaHash,
        typePolicyHash,
      }),
      identity({
        ...previous,
        schemaFormat: previous.schemaFormat,
        dialect: { ...previous.dialect, capabilityFingerprint: previous.dialect.capabilityFingerprint },
      }),
    ).outcome === "compatible"
  );
}

export function buildQueryManifest<Snapshot extends SchemaSnapshot, Policy>(
  options: BuildQueryManifestOptions<Snapshot, Policy>,
): BuildQueryManifestResult {
  if (options.compilerVersion.length === 0) throw new TypeError("compilerVersion must be a non-empty string");
  if (options.schema.dialect !== options.dialect.id) {
    throw new TypeError(`Dialect ${options.dialect.id} cannot build a manifest for ${options.schema.dialect}`);
  }
  const schemaHash = calculateSchemaHash(options.schema);
  const typePolicyHash = calculateTypePolicyHash(options.typePolicy ?? {});
  const capabilityStates = resolveDialectCapabilityStates(options.dialect, options.schema, options.typePolicy);
  const capabilityFingerprint = sha256(JSON.stringify(capabilityStates));
  const inputs = options.sources
    .map((input) => ({ input, file: portableRelative(options.rootDir, input.file), hash: sha256(input.source) }))
    .sort((left, right) => compareText(left.file, right.file));
  const duplicate = inputs.find((input, index) => input.file === inputs[index - 1]?.file);
  if (duplicate !== undefined) throw new TypeError(`Duplicate manifest source ${duplicate.file}`);

  const mayReuse = compatiblePrevious(
    options.previous,
    options.compilerVersion,
    options.dialect,
    capabilityFingerprint,
    options.schema.formatVersion,
    schemaHash,
    typePolicyHash,
  );
  const previousSources = new Map(options.previous?.sources.map((source) => [source.file, source.hash]) ?? []);
  const previousEntries = new Map<string, readonly QueryManifestEntry[]>();
  for (const entry of options.previous?.queries ?? []) {
    const entries = previousEntries.get(entry.source.file);
    previousEntries.set(entry.source.file, entries === undefined ? [entry] : [...entries, entry]);
  }

  let analyzedFiles = 0;
  let reusedFiles = 0;
  const queries = inputs.flatMap(({ input, file, hash }) => {
    if (mayReuse && previousSources.get(file) === hash) {
      reusedFiles += 1;
      return previousEntries.get(file) ?? [];
    }
    analyzedFiles += 1;
    return sourceEntries(file, input.source, options, capabilityStates);
  });
  queries.sort(
    (left, right) =>
      compareText(left.source.file, right.source.file) || left.source.range.start - right.source.range.start,
  );
  const projects = [
    ...new Set((options.projects ?? []).map((project) => portableRelative(options.rootDir, project))),
  ].sort();
  const manifest: QueryManifest = {
    formatVersion: QUERY_MANIFEST_FORMAT_VERSION,
    compilerVersion: options.compilerVersion,
    fingerprintAlgorithm: QUERY_FINGERPRINT_ALGORITHM,
    dialect: {
      id: options.dialect.id,
      grammarVersion: options.dialect.grammarVersion,
      capabilityFingerprint,
    },
    schemaFormat: options.schema.formatVersion,
    schemaHash,
    typePolicyHash,
    projects,
    sources: inputs.map(({ file, hash }) => ({ file, hash })),
    queries,
  };
  return {
    manifest,
    stats: {
      analyzedFiles,
      reusedFiles,
      resolvedQueries: queries.filter((query) => query.status === "resolved").length,
      unresolvedQueries: queries.filter((query) => query.status === "unresolved").length,
    },
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

export function serializeQueryManifest(manifest: QueryManifest): string {
  return `${JSON.stringify(canonicalize(manifest), null, 2)}\n`;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, description: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${description} must be a string`);
}

function assertRange(value: unknown, description: string): asserts value is SourceRange {
  if (!record(value)) throw new TypeError(`${description} must be a source range`);
  for (const property of ["start", "end", "line", "column"] as const) {
    const minimum = property === "line" || property === "column" ? 1 : 0;
    if (!Number.isSafeInteger(value[property]) || (value[property] as number) < minimum) {
      throw new TypeError(`${description}.${property} must be a safe integer greater than or equal to ${minimum}`);
    }
  }
  if ((value.end as number) < (value.start as number)) throw new TypeError(`${description}.end must not precede start`);
}

function assertDiagnostics(value: unknown, description: string): asserts value is readonly QueryManifestDiagnostic[] {
  if (!Array.isArray(value)) throw new TypeError(`${description} must be an array`);
  for (const diagnostic of value) {
    if (!record(diagnostic)) throw new TypeError(`${description} entries must be objects`);
    assertString(diagnostic.code, `${description} code`);
    if (!(["error", "warning", "info"] as const).includes(diagnostic.severity as never)) {
      throw new TypeError(`${description} severity is unsupported`);
    }
    assertRange(diagnostic.range, `${description} range`);
  }
}

function assertEvidence(value: unknown, description: string): void {
  if (!Array.isArray(value)) throw new TypeError(`${description} must be an array`);
  for (const evidence of value) {
    if (!record(evidence) || !(["syntax", "schema", "conservative"] as const).includes(evidence.kind as never)) {
      throw new TypeError(`${description} contains unsupported evidence`);
    }
    assertRange(evidence.range, `${description} range`);
  }
}

function assertFact(value: unknown, allowed: readonly string[], description: string): void {
  if (!record(value) || typeof value.value !== "string" || !allowed.includes(value.value)) {
    throw new TypeError(`${description} contains an unsupported value`);
  }
  assertEvidence(value.evidence, `${description} evidence`);
}

function assertSemantics(value: unknown, description: string): asserts value is QueryManifestSemantics {
  if (!record(value) || value.version !== 1) throw new TypeError(`${description} must use semantics version 1`);
  assertFact(value.operation, ["read", "write", "ddl", "transaction-control", "unknown"], `${description} operation`);
  assertFact(value.volatility, ["immutable", "stable", "volatile", "unknown"], `${description} volatility`);
  assertFact(value.locking, ["none", "row", "table", "unknown"], `${description} locking`);
  assertFact(value.connectionAffinity, ["none", "transaction", "session", "unknown"], `${description} affinity`);
  if (!record(value.cardinality) || (value.cardinality.minimum !== 0 && value.cardinality.minimum !== 1)) {
    throw new TypeError(`${description} cardinality is invalid`);
  }
  if (![0, 1, "many", "unknown"].includes(value.cardinality.maximum as never)) {
    throw new TypeError(`${description} cardinality maximum is invalid`);
  }
  assertEvidence(value.cardinality.evidence, `${description} cardinality evidence`);
  if (!Array.isArray(value.dependencies)) throw new TypeError(`${description} dependencies must be an array`);
  for (const dependency of value.dependencies) {
    if (!record(dependency)) throw new TypeError(`${description} dependencies must contain objects`);
    for (const property of ["kind", "access", "name", "certainty"] as const) {
      assertString(dependency[property], `${description} dependency ${property}`);
    }
    if (
      !["relation", "column", "function", "type", "sequence", "unknown"].includes(dependency.kind as never) ||
      !["read", "write", "execute", "reference", "unknown"].includes(dependency.access as never) ||
      !["resolved", "syntactic"].includes(dependency.certainty as never)
    ) {
      throw new TypeError(`${description} dependency classification is unsupported`);
    }
    if (dependency.schema !== undefined) assertString(dependency.schema, `${description} dependency schema`);
    if (dependency.parent !== undefined) assertString(dependency.parent, `${description} dependency parent`);
    assertRange(dependency.range, `${description} dependency range`);
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.some((capability) => typeof capability !== "string")) {
    throw new TypeError(`${description} capabilities must contain strings`);
  }
}

function assertCapabilityEvidence(
  value: unknown,
  description: string,
): asserts value is readonly QueryManifestCapabilityEvidence[] {
  if (!Array.isArray(value)) throw new TypeError(`${description} must be an array`);
  const capabilities: string[] = [];
  for (const item of value) {
    if (!record(item)) throw new TypeError(`${description} entries must be objects`);
    assertString(item.capability, `${description} capability`);
    assertString(item.reason, `${description} reason`);
    if (!/^[a-z][A-Za-z0-9]*$/u.test(item.capability) || item.reason.length === 0) {
      throw new TypeError(`${description} contains an invalid capability or reason`);
    }
    if (!(item.level === "exact" || item.level === "conservative" || item.level === "unsupported")) {
      throw new TypeError(`${description} contains an invalid capability level`);
    }
    for (const property of ["since", "until", "diagnostic"] as const) {
      if (item[property] !== undefined) assertString(item[property], `${description} ${property}`);
    }
    if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
      throw new TypeError(`${description} entries require evidence`);
    }
    for (const evidence of item.evidence) {
      if (!record(evidence)) throw new TypeError(`${description} evidence must contain objects`);
      if (!(["server-version", "feature", "setting", "policy", "grammar"] as const).includes(evidence.kind as never)) {
        throw new TypeError(`${description} contains an invalid evidence kind`);
      }
      assertString(evidence.key, `${description} evidence key`);
      assertString(evidence.value, `${description} evidence value`);
    }
    capabilities.push(item.capability);
  }
  if (capabilities.some((capability, index) => capability !== [...new Set(capabilities)].sort(compareText)[index])) {
    throw new TypeError(`${description} must be sorted and unique`);
  }
}

function assertVariant(value: unknown, description: string): asserts value is QueryManifestVariant {
  if (!record(value)) throw new TypeError(`${description} must be an object`);
  assertString(value.fingerprint, `${description}.fingerprint`);
  assertString(value.rowType, `${description}.rowType`);
  assertString(value.parameterType, `${description}.parameterType`);
  if (!/^sha256:[a-f\d]{64}$/u.test(value.fingerprint)) {
    throw new TypeError(`${description}.fingerprint must use SHA-256`);
  }
  if (
    !record(value.choices) ||
    Object.entries(value.choices).some(
      ([choice, enabled]) => !/^sha256:[a-f\d]{64}$/u.test(choice) || typeof enabled !== "boolean",
    )
  ) {
    throw new TypeError(`${description}.choices must contain booleans`);
  }
  if (!Array.isArray(value.columns) || !Array.isArray(value.parameters)) {
    throw new TypeError(`${description} columns and parameters must be arrays`);
  }
  for (const column of value.columns) {
    if (!record(column) || typeof column.nullable !== "boolean") {
      throw new TypeError(`${description} columns are invalid`);
    }
    assertString(column.name, `${description} column name`);
    assertString(column.tsType, `${description} column tsType`);
    if (column.databaseType !== undefined) assertString(column.databaseType, `${description} column databaseType`);
  }
  for (const parameter of value.parameters) {
    if (
      !record(parameter) ||
      !Number.isSafeInteger(parameter.index) ||
      (parameter.index as number) < 1 ||
      typeof parameter.nullable !== "boolean"
    ) {
      throw new TypeError(`${description} parameters are invalid`);
    }
    assertString(parameter.tsType, `${description} parameter tsType`);
    if (parameter.databaseType !== undefined) {
      assertString(parameter.databaseType, `${description} parameter databaseType`);
    }
  }
  assertSemantics(value.semantics, `${description} semantics`);
  if (value.capabilityEvidence !== undefined) {
    assertCapabilityEvidence(value.capabilityEvidence, `${description} capabilityEvidence`);
  }
}

export function parseQueryManifest(value: unknown): QueryManifest {
  if (!record(value)) throw new TypeError("Query manifest must be an object");
  if (value.formatVersion !== QUERY_MANIFEST_FORMAT_VERSION) {
    throw new TypeError(
      `Unsupported query manifest format ${String(value.formatVersion)}; this release supports format ${QUERY_MANIFEST_FORMAT_VERSION}`,
    );
  }
  if (typeof value.compilerVersion !== "string" || value.compilerVersion.length === 0) {
    throw new TypeError("Query manifest compilerVersion must be a non-empty string");
  }
  if (value.fingerprintAlgorithm !== QUERY_FINGERPRINT_ALGORITHM) {
    throw new TypeError(`Unsupported query fingerprint algorithm ${String(value.fingerprintAlgorithm)}`);
  }
  if (
    !record(value.dialect) ||
    typeof value.dialect.id !== "string" ||
    value.dialect.id.length === 0 ||
    typeof value.dialect.grammarVersion !== "string" ||
    value.dialect.grammarVersion.length === 0
  ) {
    throw new TypeError("Query manifest dialect must contain id and grammarVersion");
  }
  if (
    value.dialect.capabilityFingerprint !== undefined &&
    (typeof value.dialect.capabilityFingerprint !== "string" ||
      !/^[a-f\d]{64}$/u.test(value.dialect.capabilityFingerprint))
  ) {
    throw new TypeError("Query manifest dialect capabilityFingerprint must be a SHA-256 hash");
  }
  if (value.schemaFormat !== undefined && value.schemaFormat !== 1 && value.schemaFormat !== 2) {
    throw new TypeError("Query manifest schemaFormat must be 1 or 2");
  }
  if (
    typeof value.schemaHash !== "string" ||
    !/^[a-f\d]{64}$/u.test(value.schemaHash) ||
    typeof value.typePolicyHash !== "string" ||
    !/^[a-f\d]{64}$/u.test(value.typePolicyHash)
  ) {
    throw new TypeError("Query manifest schemaHash and typePolicyHash must be strings");
  }
  if (!Array.isArray(value.projects) || !Array.isArray(value.sources) || !Array.isArray(value.queries)) {
    throw new TypeError("Query manifest projects, sources, and queries must be arrays");
  }
  if (value.projects.some((project) => typeof project !== "string" || !isPortableRelativePath(project))) {
    throw new TypeError("Query manifest projects must contain relative paths");
  }
  for (const source of value.sources) {
    if (
      !record(source) ||
      typeof source.file !== "string" ||
      !isPortableRelativePath(source.file) ||
      typeof source.hash !== "string" ||
      !/^[a-f\d]{64}$/u.test(source.hash)
    ) {
      throw new TypeError("Query manifest sources must contain relative file paths and hashes");
    }
  }
  for (const query of value.queries) {
    if (
      !record(query) ||
      typeof query.id !== "string" ||
      !/^sha256:[a-f\d]{64}$/u.test(query.id) ||
      !record(query.source)
    ) {
      throw new TypeError("Query manifest entries must contain id and source");
    }
    const location = query.source;
    if (typeof location.file !== "string" || !isPortableRelativePath(location.file) || !record(location.range)) {
      throw new TypeError("Query manifest entry sources must contain a relative file and range");
    }
    assertRange(location.range, "Query manifest source range");
    if (query.status === "resolved") {
      if (
        typeof query.fingerprint !== "string" ||
        !/^sha256:[a-f\d]{64}$/u.test(query.fingerprint) ||
        typeof query.rowType !== "string" ||
        typeof query.parameterType !== "string" ||
        typeof query.structural !== "boolean" ||
        !Array.isArray(query.variants) ||
        query.variants.length === 0
      ) {
        throw new TypeError("Resolved query manifest entries are incomplete");
      }
      assertDiagnostics(query.diagnostics, "Resolved query diagnostics");
      for (const [index, variant] of query.variants.entries()) {
        assertVariant(variant, `Query manifest variant ${index}`);
      }
      assertSemantics(query.semantics, "Resolved query semantics");
      if (query.capabilityEvidence !== undefined) {
        assertCapabilityEvidence(query.capabilityEvidence, "Resolved query capabilityEvidence");
      }
    } else if (query.status === "unresolved") {
      if (query.reason !== "diagnostic" && query.reason !== "dynamic") {
        throw new TypeError("Unresolved query manifest entries are incomplete");
      }
      assertDiagnostics(query.diagnostics, "Unresolved query diagnostics");
      if (query.diagnostics.length === 0) throw new TypeError("Unresolved query diagnostics cannot be empty");
    } else throw new TypeError(`Unsupported query manifest entry status ${String(query.status)}`);
  }
  return value as unknown as QueryManifest;
}

/** Machine-readable public contract. Readers accept unknown object properties within format v1. */
export const QUERY_MANIFEST_JSON_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:typed-sql:query-manifest:1",
  title: "typed-sql query manifest",
  type: "object",
  $defs: {
    relativePath: { type: "string", minLength: 1, pattern: "^(?!/|\\\\|[A-Za-z]:[\\\\/])(?!.*\\u0000).+$" },
    hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    fingerprint: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    range: {
      type: "object",
      required: ["start", "end", "line", "column"],
      properties: {
        start: { type: "integer", minimum: 0 },
        end: { type: "integer", minimum: 0 },
        line: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 1 },
      },
    },
    diagnostic: {
      type: "object",
      required: ["code", "range", "severity"],
      properties: {
        code: { type: "string" },
        range: { $ref: "#/$defs/range" },
        severity: { enum: ["error", "warning", "info"] },
      },
    },
    evidence: {
      type: "object",
      required: ["kind", "range"],
      properties: {
        kind: { enum: ["syntax", "schema", "conservative"] },
        range: { $ref: "#/$defs/range" },
      },
    },
    capabilityStateEvidence: {
      type: "object",
      required: ["kind", "key", "value"],
      properties: {
        kind: { enum: ["server-version", "feature", "setting", "policy", "grammar"] },
        key: { type: "string", minLength: 1 },
        value: { type: "string", minLength: 1 },
      },
    },
    capabilityEvidence: {
      type: "object",
      required: ["capability", "level", "reason", "evidence"],
      properties: {
        capability: { type: "string", pattern: "^[a-z][A-Za-z0-9]*$" },
        level: { enum: ["exact", "conservative", "unsupported"] },
        reason: { type: "string", minLength: 1 },
        since: { type: "string", minLength: 1 },
        until: { type: "string", minLength: 1 },
        diagnostic: { type: "string", minLength: 1 },
        evidence: { type: "array", minItems: 1, items: { $ref: "#/$defs/capabilityStateEvidence" } },
      },
    },
    fact: {
      type: "object",
      required: ["value", "evidence"],
      properties: {
        value: { type: "string" },
        evidence: { type: "array", items: { $ref: "#/$defs/evidence" } },
      },
    },
    dependency: {
      type: "object",
      required: ["kind", "access", "name", "certainty", "range"],
      properties: {
        kind: { enum: ["relation", "column", "function", "type", "sequence", "unknown"] },
        access: { enum: ["read", "write", "execute", "reference", "unknown"] },
        name: { type: "string" },
        schema: { type: "string" },
        parent: { type: "string" },
        certainty: { enum: ["resolved", "syntactic"] },
        range: { $ref: "#/$defs/range" },
      },
    },
    semantics: {
      type: "object",
      required: [
        "version",
        "operation",
        "dependencies",
        "cardinality",
        "volatility",
        "locking",
        "connectionAffinity",
        "capabilities",
      ],
      properties: {
        version: { const: 1 },
        operation: { $ref: "#/$defs/fact" },
        dependencies: { type: "array", items: { $ref: "#/$defs/dependency" } },
        cardinality: {
          type: "object",
          required: ["minimum", "maximum", "evidence"],
          properties: {
            minimum: { enum: [0, 1] },
            maximum: { enum: [0, 1, "many", "unknown"] },
            evidence: { type: "array", items: { $ref: "#/$defs/evidence" } },
          },
        },
        volatility: { $ref: "#/$defs/fact" },
        locking: { $ref: "#/$defs/fact" },
        connectionAffinity: { $ref: "#/$defs/fact" },
        capabilities: { type: "array", items: { type: "string" } },
      },
    },
    column: {
      type: "object",
      required: ["name", "tsType", "nullable"],
      properties: {
        name: { type: "string" },
        tsType: { type: "string" },
        nullable: { type: "boolean" },
        databaseType: { type: "string" },
      },
    },
    parameter: {
      type: "object",
      required: ["index", "tsType", "nullable"],
      properties: {
        index: { type: "integer", minimum: 1 },
        tsType: { type: "string" },
        nullable: { type: "boolean" },
        databaseType: { type: "string" },
      },
    },
    variant: {
      type: "object",
      required: ["fingerprint", "choices", "rowType", "parameterType", "columns", "parameters", "semantics"],
      properties: {
        fingerprint: { $ref: "#/$defs/fingerprint" },
        choices: {
          type: "object",
          propertyNames: { $ref: "#/$defs/fingerprint" },
          additionalProperties: { type: "boolean" },
        },
        rowType: { type: "string" },
        parameterType: { type: "string" },
        columns: { type: "array", items: { $ref: "#/$defs/column" } },
        parameters: { type: "array", items: { $ref: "#/$defs/parameter" } },
        semantics: { $ref: "#/$defs/semantics" },
        capabilityEvidence: { type: "array", items: { $ref: "#/$defs/capabilityEvidence" } },
      },
    },
    location: {
      type: "object",
      required: ["file", "range"],
      properties: { file: { $ref: "#/$defs/relativePath" }, range: { $ref: "#/$defs/range" } },
    },
    resolvedQuery: {
      type: "object",
      required: [
        "id",
        "source",
        "status",
        "structural",
        "fingerprint",
        "rowType",
        "parameterType",
        "diagnostics",
        "variants",
        "semantics",
      ],
      properties: {
        id: { $ref: "#/$defs/fingerprint" },
        source: { $ref: "#/$defs/location" },
        status: { const: "resolved" },
        structural: { type: "boolean" },
        fingerprint: { $ref: "#/$defs/fingerprint" },
        rowType: { type: "string" },
        parameterType: { type: "string" },
        diagnostics: { type: "array", items: { $ref: "#/$defs/diagnostic" } },
        variants: { type: "array", minItems: 1, items: { $ref: "#/$defs/variant" } },
        semantics: { $ref: "#/$defs/semantics" },
        capabilityEvidence: { type: "array", items: { $ref: "#/$defs/capabilityEvidence" } },
      },
    },
    unresolvedQuery: {
      type: "object",
      required: ["id", "source", "status", "reason", "diagnostics"],
      properties: {
        id: { $ref: "#/$defs/fingerprint" },
        source: { $ref: "#/$defs/location" },
        status: { const: "unresolved" },
        reason: { enum: ["diagnostic", "dynamic"] },
        diagnostics: { type: "array", minItems: 1, items: { $ref: "#/$defs/diagnostic" } },
      },
    },
  },
  required: [
    "formatVersion",
    "compilerVersion",
    "fingerprintAlgorithm",
    "dialect",
    "schemaHash",
    "typePolicyHash",
    "projects",
    "sources",
    "queries",
  ],
  properties: {
    formatVersion: { const: QUERY_MANIFEST_FORMAT_VERSION },
    compilerVersion: { type: "string", minLength: 1 },
    fingerprintAlgorithm: { const: QUERY_FINGERPRINT_ALGORITHM },
    dialect: {
      type: "object",
      required: ["id", "grammarVersion"],
      properties: {
        id: { type: "string" },
        grammarVersion: { type: "string" },
        capabilityFingerprint: { $ref: "#/$defs/hash" },
      },
    },
    schemaFormat: { enum: [1, 2] },
    schemaHash: { type: "string" },
    typePolicyHash: { type: "string" },
    projects: { type: "array", items: { $ref: "#/$defs/relativePath" } },
    sources: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "hash"],
        properties: { file: { $ref: "#/$defs/relativePath" }, hash: { $ref: "#/$defs/hash" } },
      },
    },
    queries: {
      type: "array",
      items: { oneOf: [{ $ref: "#/$defs/resolvedQuery" }, { $ref: "#/$defs/unresolvedQuery" }] },
    },
  },
} as const);
