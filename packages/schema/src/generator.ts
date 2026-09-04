import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  GeneratedSchemaMetadata,
  GeneratedSchemaSnapshot,
  SchemaSnapshot,
  SchemaSnapshotV1,
  SchemaSnapshotV2,
} from "./model.js";
import { LEGACY_SCHEMA_FORMAT_VERSION, SCHEMA_FORMAT_VERSION } from "./model.js";
import { compareLegacySchemaKeys, compareSchemaKeys } from "./ordering.js";
import { upgradeSchemaSnapshotV1 } from "./v1/upgrade.js";
import { parseSchemaSnapshotV2, schemaSnapshotV2Envelope } from "./v2/codec.js";

export interface GenerateSchemaOptions {
  readonly outDir: string;
  readonly typePolicy?: unknown;
  readonly generatorVersion?: string;
  readonly dialectVersion?: string;
}

/** Structural bridge used by neutral compiler packages that cannot depend on schema model types. */
export interface SchemaHashInput {
  readonly formatVersion: 1 | 2;
  readonly dialect: string;
  readonly dialectVersion?: string;
  readonly version?: string;
  readonly server?: unknown;
  readonly tables: Readonly<Record<string, unknown>>;
  readonly enums?: Readonly<Record<string, readonly string[]>>;
  readonly domains?: Readonly<Record<string, unknown>>;
  readonly functions?: Readonly<Record<string, unknown>>;
  readonly namespaces?: Readonly<Record<string, unknown>>;
  readonly types?: Readonly<Record<string, unknown>>;
  readonly relations?: Readonly<Record<string, unknown>>;
  readonly routines?: Readonly<Record<string, unknown>>;
  readonly extension?: unknown;
}

export function canonicalizeSchemaValue(value: unknown): unknown {
  return canonicalize(value, compareSchemaKeys);
}

function canonicalize(value: unknown, compare: (left: string, right: string) => number): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, compare));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => compare(a, b))
      .map(([key, item]) => [key, canonicalize(item, compare)]),
  );
}

const hash = (value: unknown, compare = compareSchemaKeys): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(value, compare)))
    .digest("hex");

/** One-way identity for semantically relevant expressions that must not be stored verbatim. */
export function fingerprintSchemaExpression(expression: string): string {
  return `sha256:${createHash("sha256").update(expression).digest("hex")}`;
}

function hashableSchema(schema: SchemaHashInput, compare = compareSchemaKeys): unknown {
  if (schema.formatVersion === SCHEMA_FORMAT_VERSION) {
    if (
      schema.dialectVersion === undefined ||
      schema.server === undefined ||
      schema.namespaces === undefined ||
      schema.types === undefined ||
      schema.relations === undefined ||
      schema.routines === undefined
    ) {
      throw new TypeError("Schema format 2 hashing requires the complete v2 envelope");
    }
    const normalized = parseSchemaSnapshotV2(schemaSnapshotV2Envelope(schema as SchemaSnapshotV2), compare);
    const { metadata: _metadata, ...envelope } = schemaSnapshotV2Envelope(normalized);
    return envelope;
  }
  return schema;
}

export function serializeSchemaSnapshot(schema: SchemaSnapshot, spacing?: number): string {
  return JSON.stringify(canonicalizeSchemaValue(hashableSchema(schema)), null, spacing);
}

export function calculateSchemaHash(schema: SchemaHashInput): string {
  return hash(hashableSchema(schema));
}

export function calculateTypePolicyHash(policy: unknown): string {
  return hash(policy);
}

/** Accept new portable hashes and legacy hashes valid under this process's locale. */
export function matchesSchemaHash(schema: SchemaHashInput, expected: string): boolean {
  return (
    calculateSchemaHash(schema) === expected ||
    hash(hashableSchema(schema, compareLegacySchemaKeys), compareLegacySchemaKeys) === expected
  );
}

/** Legacy fallback validates the same policy; it never bypasses content checking. */
export function matchesTypePolicyHash(policy: unknown, expected: string): boolean {
  return calculateTypePolicyHash(policy) === expected || hash(policy, compareLegacySchemaKeys) === expected;
}

export interface SchemaDriftResult {
  readonly drifted: boolean;
  readonly schemaChanged: boolean;
  readonly typePolicyChanged: boolean;
  readonly expectedSchemaHash: string;
  readonly actualSchemaHash: string;
  readonly expectedTypePolicyHash: string;
  readonly actualTypePolicyHash: string;
  /** Stable, value-free identities explaining what changed. */
  readonly changes: readonly SchemaDriftChange[];
}

export type SchemaDriftChangeKind =
  | "schema"
  | "dialect"
  | "server"
  | "namespace"
  | "type"
  | "relation"
  | "routine"
  | "extension"
  | "type-policy";

export interface SchemaDriftChange {
  readonly kind: SchemaDriftChangeKind;
  readonly key: string;
}

function different(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalizeSchemaValue(left)) !== JSON.stringify(canonicalizeSchemaValue(right));
}

function changedKeys(
  kind: SchemaDriftChangeKind,
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): SchemaDriftChange[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .sort()
    .filter((key) => different(left[key], right[key]))
    .map((key) => ({ kind, key }));
}

function explainSchemaDrift(
  generated: GeneratedSchemaSnapshot,
  current: SchemaSnapshot,
  schemaChanged: boolean,
  typePolicyChanged: boolean,
): readonly SchemaDriftChange[] {
  const changes: SchemaDriftChange[] = [];
  if (generated.dialect !== current.dialect || generated.dialectVersion !== current.dialectVersion) {
    changes.push({ kind: "dialect", key: generated.dialect });
  }
  if (generated.formatVersion === 2 && current.formatVersion === 2) {
    if (different(generated.server, current.server)) changes.push({ kind: "server", key: generated.server.product });
    changes.push(...changedKeys("namespace", generated.namespaces, current.namespaces));
    changes.push(...changedKeys("type", generated.types, current.types));
    changes.push(...changedKeys("relation", generated.relations, current.relations));
    changes.push(...changedKeys("routine", generated.routines, current.routines));
    if (different(generated.extension, current.extension)) changes.push({ kind: "extension", key: generated.dialect });
  } else {
    changes.push(...changedKeys("relation", generated.tables, current.tables));
    changes.push(...changedKeys("type", generated.enums ?? {}, current.enums ?? {}));
    changes.push(...changedKeys("type", generated.domains ?? {}, current.domains ?? {}));
    changes.push(...changedKeys("routine", generated.functions ?? {}, current.functions ?? {}));
  }
  if (schemaChanged && changes.length === 0) changes.push({ kind: "schema", key: generated.dialect });
  if (typePolicyChanged) changes.push({ kind: "type-policy", key: "type-policy" });
  return changes.sort((left, right) => left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key));
}

export function checkSchemaDrift(
  generated: GeneratedSchemaSnapshot,
  current: SchemaSnapshot,
  policy: unknown = {},
): SchemaDriftResult {
  const comparableCurrent: SchemaSnapshot =
    generated.formatVersion === SCHEMA_FORMAT_VERSION
      ? {
          ...(current.formatVersion === SCHEMA_FORMAT_VERSION ? current : upgradeSchemaSnapshotV1(current)),
          dialectVersion: generated.dialectVersion,
        }
      : current.formatVersion === LEGACY_SCHEMA_FORMAT_VERSION
        ? {
            ...current,
            ...(generated.dialectVersion === undefined ? {} : { dialectVersion: generated.dialectVersion }),
          }
        : ({
            formatVersion: LEGACY_SCHEMA_FORMAT_VERSION,
            dialect: current.dialect,
            ...(generated.dialectVersion === undefined ? {} : { dialectVersion: generated.dialectVersion }),
            version: current.server.version,
            server: current.server,
            tables: current.tables,
            ...(current.enums === undefined ? {} : { enums: current.enums }),
            ...(current.domains === undefined ? {} : { domains: current.domains }),
            ...(current.functions === undefined ? {} : { functions: current.functions }),
          } satisfies SchemaSnapshotV1);
  const actualSchemaHash = calculateSchemaHash(comparableCurrent);
  const actualTypePolicyHash = calculateTypePolicyHash(policy);
  const schemaChanged = !matchesSchemaHash(comparableCurrent, generated.metadata.schemaHash);
  const typePolicyChanged = !matchesTypePolicyHash(policy, generated.metadata.typePolicyHash);
  return {
    drifted: schemaChanged || typePolicyChanged,
    schemaChanged,
    typePolicyChanged,
    expectedSchemaHash: generated.metadata.schemaHash,
    actualSchemaHash,
    expectedTypePolicyHash: generated.metadata.typePolicyHash,
    actualTypePolicyHash,
    changes: explainSchemaDrift(generated, comparableCurrent, schemaChanged, typePolicyChanged),
  };
}

export async function generateSchemaPackage(
  schema: SchemaSnapshot,
  options: GenerateSchemaOptions,
): Promise<GeneratedSchemaMetadata> {
  const policy = options.typePolicy ?? {};
  const versionedSchema: SchemaSnapshotV2 =
    schema.formatVersion === SCHEMA_FORMAT_VERSION
      ? {
          ...schema,
          ...(options.dialectVersion === undefined ? {} : { dialectVersion: options.dialectVersion }),
        }
      : upgradeSchemaSnapshotV1({
          ...schema,
          ...(options.dialectVersion === undefined ? {} : { dialectVersion: options.dialectVersion }),
        });
  const normalizedSchema = parseSchemaSnapshotV2(schemaSnapshotV2Envelope(versionedSchema));
  const metadata: GeneratedSchemaMetadata = {
    generatorVersion: options.generatorVersion ?? "1.0.0",
    schemaHash: calculateSchemaHash(normalizedSchema),
    typePolicyHash: calculateTypePolicyHash(policy),
    schemaFormat: SCHEMA_FORMAT_VERSION,
  };
  const serializedSchema = schemaSnapshotV2Envelope(normalizedSchema);
  await mkdir(options.outDir, { recursive: true });
  await writeFile(
    join(options.outDir, "schema.json"),
    `${JSON.stringify(canonicalizeSchemaValue({ ...serializedSchema, metadata }), null, 2)}\n`,
    "utf8",
  );
  const moduleSource = [
    `// Generated by @typed-sql/cli ${metadata.generatorVersion}. Schema metadata only; do not edit.`,
    `export const schema = ${JSON.stringify(canonicalizeSchemaValue(serializedSchema), null, 2)} as const;`,
    `export const metadata = ${JSON.stringify(metadata, null, 2)} as const;`,
    "export type DatabaseSchema = typeof schema;",
    "",
  ].join("\n");
  await writeFile(join(options.outDir, "index.ts"), moduleSource, "utf8");
  return metadata;
}

export type { GeneratedSchemaMetadata } from "./model.js";
