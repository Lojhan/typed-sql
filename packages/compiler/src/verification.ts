import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  DialectPlugin,
  LiveQueryVerificationEvidence,
  LiveQueryVerificationField,
  LiveQueryVerificationServer,
  LiveQueryVerifier,
  QuerySemantics,
  ResolvedColumn,
  ResolvedParameter,
  SchemaSnapshot,
} from "@typed-sql/core";
import { compileSource } from "./compiler.js";
import {
  buildQueryManifest,
  type QueryManifest,
  type QueryManifestLocation,
  serializeQueryManifest,
} from "./manifest.js";

export const QUERY_VERIFICATION_FORMAT_VERSION = 1 as const;
export const QUERY_VERIFIER_VERSION = "typed-sql-v1" as const;

export interface QueryVerificationCandidate {
  readonly queryId: string;
  readonly variantFingerprint: string;
  readonly source: QueryManifestLocation;
  /** Transient compiler output. This field is intentionally absent from proof artifacts. */
  readonly sql: string;
  readonly operation: QuerySemantics["operation"]["value"];
  readonly columns: readonly QueryVerificationExpectedField[];
  readonly parameters: readonly QueryVerificationExpectedField[];
}

export interface QueryVerificationExpectedField {
  readonly index: number;
  readonly name?: string;
  readonly databaseType?: string;
  readonly tsType: string;
  readonly nullable: boolean;
}

export interface CollectQueryVerificationCandidatesOptions<Snapshot extends SchemaSnapshot, Policy> {
  readonly manifest: QueryManifest;
  readonly rootDir: string;
  readonly sources: readonly { readonly file: string; readonly source: string }[];
  readonly projects?: readonly string[];
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly schema: Snapshot;
  readonly typePolicy?: Policy;
  readonly maxStructuralVariants?: number;
}

export type QueryVerificationMismatchKind =
  | "column-count"
  | "parameter-count"
  | "column-name"
  | "database-type"
  | "typescript-type"
  | "nullability";

export interface QueryVerificationMismatch {
  readonly kind: QueryVerificationMismatchKind;
  readonly target: "column" | "parameter";
  readonly index?: number;
  readonly expected: string;
  readonly actual: string;
}

export interface QueryVerificationEvidence {
  readonly columns: readonly LiveQueryVerificationField[];
  readonly parameters: readonly LiveQueryVerificationField[];
}

interface QueryVerificationEntryBase {
  readonly queryId: string;
  readonly source: QueryManifestLocation;
}

export interface VerifiedQueryProofEntry extends QueryVerificationEntryBase {
  readonly variantFingerprint: string;
  readonly status: "verified";
  readonly evidence: QueryVerificationEvidence;
}

export interface MismatchedQueryProofEntry extends QueryVerificationEntryBase {
  readonly variantFingerprint: string;
  readonly status: "mismatch";
  readonly code: "TSQ500";
  readonly mismatches: readonly QueryVerificationMismatch[];
  readonly evidence: QueryVerificationEvidence;
}

export interface SkippedQueryProofEntry extends QueryVerificationEntryBase {
  readonly variantFingerprint?: string;
  readonly status: "skipped";
  readonly code: "TSQ501";
  readonly reason: "manifest-unresolved" | "unsafe-operation" | "candidate-missing" | "native-metadata-unavailable";
}

export interface FailedQueryProofEntry extends QueryVerificationEntryBase {
  readonly variantFingerprint: string;
  readonly status: "error";
  readonly code: "TSQ502";
  readonly reason: "native-verification-failed";
}

export type QueryVerificationProofEntry =
  | VerifiedQueryProofEntry
  | MismatchedQueryProofEntry
  | SkippedQueryProofEntry
  | FailedQueryProofEntry;

export interface QueryVerificationProof {
  readonly formatVersion: typeof QUERY_VERIFICATION_FORMAT_VERSION;
  readonly verifierVersion: typeof QUERY_VERIFIER_VERSION;
  readonly adapterVersion: string;
  readonly dialect: string;
  readonly manifestHash: string;
  readonly cacheKey: string;
  readonly server: LiveQueryVerificationServer;
  readonly entries: readonly QueryVerificationProofEntry[];
}

export interface VerifyQueryManifestOptions {
  readonly manifest: QueryManifest;
  readonly candidates: readonly QueryVerificationCandidate[];
  readonly verifier: LiveQueryVerifier;
  readonly concurrency?: number;
}

export interface VerifyQueryManifestResult {
  readonly proof: QueryVerificationProof;
  readonly verified: number;
  readonly mismatched: number;
  readonly skipped: number;
  readonly failed: number;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function portableRelative(rootDir: string, file: string): string {
  const root = resolve(rootDir);
  const path = relative(root, isAbsolute(file) ? resolve(file) : resolve(root, file))
    .split(sep)
    .join("/");
  if (path.length === 0 || path === ".." || path.startsWith("../") || isAbsolute(path)) {
    throw new TypeError(`Cannot make ${file} relative to ${rootDir}`);
  }
  return path;
}

function expectedColumn(column: ResolvedColumn, index: number): QueryVerificationExpectedField {
  return {
    index: index + 1,
    name: column.name,
    tsType: column.tsType,
    nullable: column.nullable,
    ...(column.databaseType === undefined ? {} : { databaseType: column.databaseType }),
  };
}

function expectedParameter(parameter: ResolvedParameter): QueryVerificationExpectedField {
  return {
    index: parameter.index,
    tsType: parameter.tsType,
    nullable: parameter.nullable,
    ...(parameter.databaseType === undefined ? {} : { databaseType: parameter.databaseType }),
  };
}

/** Recompiles source only in memory and proves that it still matches the supplied manifest. */
export function collectQueryVerificationCandidates<Snapshot extends SchemaSnapshot, Policy>(
  options: CollectQueryVerificationCandidatesOptions<Snapshot, Policy>,
): readonly QueryVerificationCandidate[] {
  const rebuilt = buildQueryManifest({
    rootDir: options.rootDir,
    sources: options.sources,
    ...(options.projects === undefined ? {} : { projects: options.projects }),
    dialect: options.dialect,
    schema: options.schema,
    ...(options.typePolicy === undefined ? {} : { typePolicy: options.typePolicy }),
    compilerVersion: options.manifest.compilerVersion,
    ...(options.maxStructuralVariants === undefined ? {} : { maxStructuralVariants: options.maxStructuralVariants }),
  }).manifest;
  if (serializeQueryManifest(rebuilt) !== serializeQueryManifest(options.manifest)) {
    throw new TypeError("Query manifest is stale; regenerate it before live verification");
  }

  const entries = new Map(
    options.manifest.queries
      .filter((entry) => entry.status === "resolved")
      .map((entry) => [`${entry.source.file}\0${entry.source.range.start}`, entry] as const),
  );
  const candidates: QueryVerificationCandidate[] = [];
  for (const input of options.sources) {
    const file = portableRelative(options.rootDir, input.file);
    const compilation = compileSource({
      source: input.source,
      dialect: options.dialect,
      schema: options.schema,
      ...(options.typePolicy === undefined ? {} : { typePolicy: options.typePolicy }),
      ...(options.maxStructuralVariants === undefined ? {} : { maxStructuralVariants: options.maxStructuralVariants }),
    });
    for (const query of compilation.queries) {
      const entry = entries.get(`${file}\0${query.query.range.start}`);
      if (entry === undefined || entry.fingerprint !== query.fingerprint) {
        throw new TypeError(`Query manifest does not match ${file}:${query.query.range.line}`);
      }
      for (const variant of query.variants) {
        if (!entry.variants.some((manifestVariant) => manifestVariant.fingerprint === variant.fingerprint)) {
          throw new TypeError(`Query manifest is missing variant ${variant.fingerprint}`);
        }
        candidates.push({
          queryId: entry.id,
          variantFingerprint: variant.fingerprint,
          source: entry.source,
          sql: variant.sql,
          operation: variant.semantics.operation.value,
          columns: variant.columns.map(expectedColumn),
          parameters: variant.parameters.map(expectedParameter),
        });
      }
    }
  }
  return candidates.sort(
    (left, right) =>
      compareText(left.source.file, right.source.file) ||
      left.source.range.start - right.source.range.start ||
      compareText(left.variantFingerprint, right.variantFingerprint),
  );
}

function normalizedType(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function topLevelUnionMembers(value: string): readonly string[] {
  const members: string[] = [];
  let start = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
    else if (char === "|" && depth === 0) {
      members.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  members.push(value.slice(start).trim());
  return members;
}

type PrimitiveType = "string" | "number" | "bigint" | "boolean" | "null" | "undefined";

function primitiveType(member: string): PrimitiveType | undefined {
  if (["string", "number", "bigint", "boolean", "null", "undefined"].includes(member)) {
    return member as PrimitiveType;
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/iu.test(member)) return "number";
  if (/^-?(?:0|[1-9]\d*)n$/u.test(member)) return "bigint";
  if (member === "true" || member === "false") return "boolean";
  if (member.startsWith('"') && member.endsWith('"')) {
    try {
      return typeof JSON.parse(member) === "string" ? "string" : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Parameter metadata describes what the server accepts, so a compiler-side literal subset is safe. */
function parameterTypeCompatible(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  const accepted = topLevelUnionMembers(actual);
  const supplied = topLevelUnionMembers(expected);
  return (
    supplied.length > 0 &&
    supplied.every((member) =>
      accepted.some(
        (target) => member === target || (primitiveType(target) === target && primitiveType(member) === target),
      ),
    )
  );
}

function compareField(
  target: "column" | "parameter",
  expected: QueryVerificationExpectedField,
  actual: LiveQueryVerificationField,
): readonly QueryVerificationMismatch[] {
  const mismatches: QueryVerificationMismatch[] = [];
  const add = (kind: QueryVerificationMismatchKind, expectedValue: string, actualValue: string) =>
    mismatches.push({ kind, target, index: expected.index, expected: expectedValue, actual: actualValue });
  if (
    target === "column" &&
    expected.name !== undefined &&
    actual.name !== undefined &&
    expected.name !== actual.name
  ) {
    add("column-name", expected.name, actual.name);
  }
  if (expected.tsType !== "unknown" && actual.tsType !== undefined) {
    if (
      expected.tsType !== actual.tsType &&
      (target !== "parameter" || !parameterTypeCompatible(expected.tsType, actual.tsType))
    ) {
      add("typescript-type", expected.tsType, actual.tsType);
    }
  } else if (
    expected.databaseType !== undefined &&
    actual.databaseType !== undefined &&
    normalizedType(expected.databaseType) !== normalizedType(actual.databaseType)
  ) {
    add("database-type", expected.databaseType, actual.databaseType);
  }
  if (actual.nullable !== undefined && expected.nullable !== actual.nullable) {
    add("nullability", String(expected.nullable), String(actual.nullable));
  }
  return mismatches;
}

function compareEvidence(
  candidate: QueryVerificationCandidate,
  evidence: LiveQueryVerificationEvidence,
): readonly QueryVerificationMismatch[] {
  const mismatches: QueryVerificationMismatch[] = [];
  if (candidate.columns.length !== evidence.columns.length) {
    mismatches.push({
      kind: "column-count",
      target: "column",
      expected: String(candidate.columns.length),
      actual: String(evidence.columns.length),
    });
  }
  if (candidate.parameters.length !== evidence.parameters.length) {
    mismatches.push({
      kind: "parameter-count",
      target: "parameter",
      expected: String(candidate.parameters.length),
      actual: String(evidence.parameters.length),
    });
  }
  for (let index = 0; index < Math.min(candidate.columns.length, evidence.columns.length); index += 1) {
    mismatches.push(...compareField("column", candidate.columns[index]!, evidence.columns[index]!));
  }
  for (let index = 0; index < Math.min(candidate.parameters.length, evidence.parameters.length); index += 1) {
    mismatches.push(...compareField("parameter", candidate.parameters[index]!, evidence.parameters[index]!));
  }
  return mismatches;
}

function safeToPrepare(operation: QueryVerificationCandidate["operation"]): boolean {
  return operation === "read" || operation === "write";
}

async function boundedMap<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  visit: (value: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const output = new Array<Output>(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await visit(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
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

function normalizedServer(server: LiveQueryVerificationServer): LiveQueryVerificationServer {
  if (typeof server.version !== "string" || server.version.length === 0)
    throw new TypeError("Live verifier server.version must be a non-empty string");
  return {
    version: server.version,
    ...(server.features === undefined ? {} : { features: [...new Set(server.features)].sort(compareText) }),
  };
}

function verificationCacheKey(value: {
  readonly adapterVersion: string;
  readonly dialect: string;
  readonly manifestHash: string;
  readonly server: LiveQueryVerificationServer;
  readonly entries: readonly QueryVerificationProofEntry[];
}): string {
  return `sha256:${sha256(
    JSON.stringify(
      canonicalize({
        verifierVersion: QUERY_VERIFIER_VERSION,
        adapterVersion: value.adapterVersion,
        dialect: value.dialect,
        manifestHash: value.manifestHash,
        server: normalizedServer(value.server),
        entries: value.entries,
      }),
    ),
  )}`;
}

export async function verifyQueryManifest(options: VerifyQueryManifestOptions): Promise<VerifyQueryManifestResult> {
  if (options.verifier.dialect !== options.manifest.dialect.id)
    throw new TypeError(`Verifier dialect ${options.verifier.dialect} does not match ${options.manifest.dialect.id}`);
  const concurrency = options.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new TypeError("verification concurrency must be a positive safe integer");
  if (options.verifier.adapterVersion.length === 0) throw new TypeError("Verifier adapterVersion must not be empty");
  const server = normalizedServer(await options.verifier.server());
  const byQuery = new Map<string, QueryVerificationCandidate[]>();
  for (const candidate of options.candidates)
    byQuery.set(candidate.queryId, [...(byQuery.get(candidate.queryId) ?? []), candidate]);
  const work: Array<QueryVerificationCandidate | SkippedQueryProofEntry> = [];
  for (const query of options.manifest.queries) {
    if (query.status === "unresolved") {
      work.push({
        queryId: query.id,
        source: query.source,
        status: "skipped",
        code: "TSQ501",
        reason: "manifest-unresolved",
      });
      continue;
    }
    const candidates = byQuery.get(query.id) ?? [];
    for (const variant of query.variants) {
      const candidate = candidates.find((item) => item.variantFingerprint === variant.fingerprint);
      if (candidate === undefined)
        work.push({
          queryId: query.id,
          variantFingerprint: variant.fingerprint,
          source: query.source,
          status: "skipped",
          code: "TSQ501",
          reason: "candidate-missing",
        });
      else if (!safeToPrepare(candidate.operation))
        work.push({
          queryId: query.id,
          variantFingerprint: variant.fingerprint,
          source: query.source,
          status: "skipped",
          code: "TSQ501",
          reason: "unsafe-operation",
        });
      else work.push(candidate);
    }
  }

  const entries = await boundedMap(work, concurrency, async (item): Promise<QueryVerificationProofEntry> => {
    if ("status" in item) return item;
    try {
      const native = await options.verifier.verify({
        fingerprint: item.variantFingerprint,
        sql: item.sql,
        operation: item.operation,
      });
      if (native.unavailable !== undefined && native.unavailable.length > 0) {
        return {
          queryId: item.queryId,
          variantFingerprint: item.variantFingerprint,
          source: item.source,
          status: "skipped",
          code: "TSQ501",
          reason: "native-metadata-unavailable",
        };
      }
      const evidence = {
        columns: native.columns.map((field) => ({ ...field })),
        parameters: native.parameters.map((field) => ({ ...field })),
      };
      const mismatches = compareEvidence(item, evidence);
      return mismatches.length === 0
        ? {
            queryId: item.queryId,
            variantFingerprint: item.variantFingerprint,
            source: item.source,
            status: "verified",
            evidence,
          }
        : {
            queryId: item.queryId,
            variantFingerprint: item.variantFingerprint,
            source: item.source,
            status: "mismatch",
            code: "TSQ500",
            mismatches,
            evidence,
          };
    } catch {
      return {
        queryId: item.queryId,
        variantFingerprint: item.variantFingerprint,
        source: item.source,
        status: "error",
        code: "TSQ502",
        reason: "native-verification-failed",
      };
    }
  });
  const manifestHash = `sha256:${sha256(serializeQueryManifest(options.manifest))}`;
  const cacheKey = verificationCacheKey({
    adapterVersion: options.verifier.adapterVersion,
    dialect: options.verifier.dialect,
    manifestHash,
    server,
    entries,
  });
  const proof: QueryVerificationProof = {
    formatVersion: QUERY_VERIFICATION_FORMAT_VERSION,
    verifierVersion: QUERY_VERIFIER_VERSION,
    adapterVersion: options.verifier.adapterVersion,
    dialect: options.verifier.dialect,
    manifestHash,
    cacheKey,
    server,
    entries,
  };
  return {
    proof,
    verified: entries.filter((entry) => entry.status === "verified").length,
    mismatched: entries.filter((entry) => entry.status === "mismatch").length,
    skipped: entries.filter((entry) => entry.status === "skipped").length,
    failed: entries.filter((entry) => entry.status === "error").length,
  };
}

export function serializeQueryVerificationProof(proof: QueryVerificationProof): string {
  return `${JSON.stringify(canonicalize(proof), null, 2)}\n`;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fingerprint(value: unknown, description: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f\d]{64}$/u.test(value)) {
    throw new TypeError(`${description} must be a SHA-256 fingerprint`);
  }
}

function sourceLocation(value: unknown): asserts value is QueryManifestLocation {
  if (
    !record(value) ||
    typeof value.file !== "string" ||
    value.file.length === 0 ||
    value.file === ".." ||
    value.file.startsWith("../") ||
    isAbsolute(value.file)
  ) {
    throw new TypeError("Query verification source must contain a relative file");
  }
  if (!record(value.range)) throw new TypeError("Query verification source range is invalid");
  for (const property of ["start", "end", "line", "column"] as const) {
    if (!Number.isSafeInteger(value.range[property])) throw new TypeError("Query verification source range is invalid");
  }
}

function evidenceFields(value: unknown, description: string): void {
  if (!Array.isArray(value)) throw new TypeError(`${description} must be an array`);
  for (const field of value) {
    if (!record(field) || !Number.isSafeInteger(field.index) || (field.index as number) < 1) {
      throw new TypeError(`${description} contains an invalid field`);
    }
    for (const property of ["name", "databaseType", "tsType"] as const) {
      if (field[property] !== undefined && typeof field[property] !== "string") {
        throw new TypeError(`${description} contains an invalid ${property}`);
      }
    }
    if (field.nullable !== undefined && typeof field.nullable !== "boolean") {
      throw new TypeError(`${description} contains invalid nullability`);
    }
  }
}

function proofEvidence(value: unknown): void {
  if (!record(value)) throw new TypeError("Query verification evidence must be an object");
  evidenceFields(value.columns, "Query verification columns");
  evidenceFields(value.parameters, "Query verification parameters");
}

export function parseQueryVerificationProof(value: unknown): QueryVerificationProof {
  if (!record(value)) throw new TypeError("Query verification proof must be an object");
  if (value.formatVersion !== QUERY_VERIFICATION_FORMAT_VERSION)
    throw new TypeError(`Unsupported query verification format ${String(value.formatVersion)}`);
  if (value.verifierVersion !== QUERY_VERIFIER_VERSION)
    throw new TypeError(`Unsupported query verifier version ${String(value.verifierVersion)}`);
  for (const property of ["adapterVersion", "dialect", "manifestHash", "cacheKey"] as const) {
    if (typeof value[property] !== "string" || value[property].length === 0)
      throw new TypeError(`Query verification proof ${property} must be a non-empty string`);
  }
  fingerprint(value.manifestHash, "Query verification manifestHash");
  fingerprint(value.cacheKey, "Query verification cacheKey");
  if (
    !record(value.server) ||
    typeof value.server.version !== "string" ||
    value.server.version.length === 0 ||
    (value.server.features !== undefined &&
      (!Array.isArray(value.server.features) ||
        value.server.features.some((feature) => typeof feature !== "string"))) ||
    !Array.isArray(value.entries)
  )
    throw new TypeError("Query verification proof server or entries are invalid");
  const statuses = new Set(["verified", "mismatch", "skipped", "error"]);
  const mismatchKinds = new Set<QueryVerificationMismatchKind>([
    "column-count",
    "parameter-count",
    "column-name",
    "database-type",
    "typescript-type",
    "nullability",
  ]);
  const skipReasons = new Set<SkippedQueryProofEntry["reason"]>([
    "manifest-unresolved",
    "unsafe-operation",
    "candidate-missing",
    "native-metadata-unavailable",
  ]);
  for (const entry of value.entries) {
    if (!record(entry) || !statuses.has(String(entry.status)))
      throw new TypeError("Query verification proof contains an invalid entry");
    fingerprint(entry.queryId, "Query verification queryId");
    sourceLocation(entry.source);
    if (entry.variantFingerprint !== undefined) fingerprint(entry.variantFingerprint, "Query verification variant");
    if (entry.status !== "skipped" && entry.variantFingerprint === undefined) {
      throw new TypeError("Query verification entry requires a variant fingerprint");
    }
    if (entry.status === "verified") proofEvidence(entry.evidence);
    else if (entry.status === "mismatch") {
      if (entry.code !== "TSQ500" || !Array.isArray(entry.mismatches))
        throw new TypeError("Query verification mismatch is invalid");
      proofEvidence(entry.evidence);
      for (const mismatch of entry.mismatches) {
        if (
          !record(mismatch) ||
          !mismatchKinds.has(mismatch.kind as QueryVerificationMismatchKind) ||
          !["column", "parameter"].includes(String(mismatch.target)) ||
          (mismatch.index !== undefined && (!Number.isSafeInteger(mismatch.index) || (mismatch.index as number) < 1)) ||
          typeof mismatch.expected !== "string" ||
          typeof mismatch.actual !== "string"
        )
          throw new TypeError("Query verification mismatch evidence is invalid");
      }
    } else if (entry.status === "skipped") {
      if (
        entry.code !== "TSQ501" ||
        !skipReasons.has(entry.reason as SkippedQueryProofEntry["reason"]) ||
        (entry.reason !== "manifest-unresolved" && entry.variantFingerprint === undefined)
      )
        throw new TypeError("Query verification skip is invalid");
    } else if (entry.code !== "TSQ502" || entry.reason !== "native-verification-failed") {
      throw new TypeError("Query verification failure is invalid");
    }
  }
  return value as unknown as QueryVerificationProof;
}

export function assertQueryVerificationProofCurrent(
  manifest: QueryManifest,
  proof: QueryVerificationProof,
  verifier?: Pick<LiveQueryVerifier, "dialect" | "adapterVersion">,
): void {
  const manifestHash = `sha256:${sha256(serializeQueryManifest(manifest))}`;
  if (proof.manifestHash !== manifestHash) throw new TypeError("Query verification proof is stale for this manifest");
  if (proof.dialect !== manifest.dialect.id) throw new TypeError("Query verification proof dialect is stale");
  if (
    verifier !== undefined &&
    (proof.dialect !== verifier.dialect || proof.adapterVersion !== verifier.adapterVersion)
  )
    throw new TypeError("Query verification proof adapter is stale");
  const expectedCacheKey = verificationCacheKey({
    adapterVersion: proof.adapterVersion,
    dialect: proof.dialect,
    manifestHash,
    server: proof.server,
    entries: proof.entries,
  });
  if (proof.cacheKey !== expectedCacheKey) throw new TypeError("Query verification proof cache key is stale");
}
