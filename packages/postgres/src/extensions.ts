import type {
  DialectExtensionValue,
  RoutineSnapshot,
  SchemaSnapshot,
  SchemaSnapshotV2,
  TypeSnapshot,
} from "@typed-sql/schema";
import { defineSchemaSnapshotV2, upgradeSchemaSnapshotV1 } from "@typed-sql/schema";
import { postgresCatalogCast } from "./catalog/index.js";

export const POSTGRES_EXTENSION_MANIFEST_FORMAT_VERSION = 1 as const;

export interface PostgresExtensionOperator {
  readonly name: string;
  readonly argumentTypes: readonly [string] | readonly [string, string];
  readonly resultType: string;
}

export interface PostgresExtensionCast {
  readonly sourceType: string;
  readonly targetType: string;
  readonly context: "explicit" | "assignment" | "implicit";
}

export interface PostgresExtensionCodec<Value = unknown, Encoded = unknown> {
  readonly databaseType: string;
  readonly decode: (value: unknown) => Value;
  readonly encode?: (value: Value) => Encoded;
}

export interface PostgresExtensionQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[] }>;
}

export interface PostgresExtensionContribution {
  readonly types?: readonly TypeSnapshot[];
  readonly routines?: readonly RoutineSnapshot[];
}

export interface PostgresExtensionManifest {
  readonly formatVersion: typeof POSTGRES_EXTENSION_MANIFEST_FORMAT_VERSION;
  readonly name: string;
  readonly supportedVersions: readonly string[];
  readonly revision: string;
  readonly types?: readonly TypeSnapshot[];
  readonly routines?: readonly RoutineSnapshot[];
  readonly operators?: readonly PostgresExtensionOperator[];
  readonly casts?: readonly PostgresExtensionCast[];
  readonly codecs?: readonly PostgresExtensionCodec[];
  readonly introspect?: (
    client: PostgresExtensionQueryable,
    installedVersion: string,
  ) => Promise<PostgresExtensionContribution>;
}

export interface PostgresExtensionIssue {
  readonly code: "TSQ403" | "TSQ407";
  readonly message: string;
}

export interface ResolvedPostgresExtensions {
  readonly snapshot: SchemaSnapshotV2;
  readonly active: readonly {
    readonly manifest: PostgresExtensionManifest;
    readonly installedVersion: string;
  }[];
  readonly codecs: ReadonlyMap<string, PostgresExtensionCodec>;
  readonly issues: readonly PostgresExtensionIssue[];
}

export class PostgresExtensionResolutionError extends Error {
  readonly issues: readonly PostgresExtensionIssue[];

  constructor(issues: readonly PostgresExtensionIssue[]) {
    super(issues.map(({ code, message }) => `${code}: ${message}`).join("; "));
    this.name = "PostgresExtensionResolutionError";
    this.issues = issues;
  }
}

interface SerializedOperator {
  readonly name: string;
  readonly argumentTypes: readonly string[];
  readonly resultType: string;
}

interface SerializedCast {
  readonly sourceType: string;
  readonly targetType: string;
  readonly context: PostgresExtensionCast["context"];
}

const extensionNamePattern = /^[a-z][a-z0-9_-]*$/u;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/u;

function deepFreeze<Value>(value: Value, seen = new Set<object>()): Value {
  if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}

function nonEmpty(value: string, path: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${path} must be non-empty`);
}

function assertSortedUnique(values: readonly string[], path: string): void {
  if (values.length === 0) throw new TypeError(`${path} must contain at least one version`);
  const sorted = [...new Set(values)].sort();
  if (values.some((value, index) => value !== sorted[index])) throw new TypeError(`${path} must be sorted and unique`);
  if (values.some((value) => !versionPattern.test(value))) throw new TypeError(`${path} contains an invalid version`);
}

function typeKey(type: TypeSnapshot): string {
  return type.schema === undefined || type.schema === "public" ? type.name : `${type.schema}.${type.name}`;
}

function routineKey(routine: RoutineSnapshot): string {
  return routine.schema === undefined || routine.schema === "public"
    ? routine.name
    : `${routine.schema}.${routine.name}`;
}

function routineSignature(routine: RoutineSnapshot): string {
  return `${routineKey(routine)}(${routine.arguments
    .filter(({ mode }) => mode !== "out")
    .map(({ databaseType }) => databaseType.toLowerCase())
    .join(",")})`;
}

function operatorSignature(operator: PostgresExtensionOperator): string {
  return `${operator.name.toUpperCase()}(${operator.argumentTypes.map((type) => type.toLowerCase()).join(",")})`;
}

function castSignature(cast: PostgresExtensionCast): string {
  return `${cast.sourceType.toLowerCase()}>${cast.targetType.toLowerCase()}`;
}

export function definePostgresExtensionManifest(manifest: PostgresExtensionManifest): PostgresExtensionManifest {
  if (manifest.formatVersion !== POSTGRES_EXTENSION_MANIFEST_FORMAT_VERSION) {
    throw new TypeError(
      `PostgreSQL extension manifest formatVersion must be ${POSTGRES_EXTENSION_MANIFEST_FORMAT_VERSION}`,
    );
  }
  if (!extensionNamePattern.test(manifest.name)) throw new TypeError("PostgreSQL extension manifest name is invalid");
  assertSortedUnique(manifest.supportedVersions, "PostgreSQL extension manifest supportedVersions");
  if (!versionPattern.test(manifest.revision)) throw new TypeError("PostgreSQL extension manifest revision is invalid");
  const identities = new Set<string>();
  for (const type of manifest.types ?? []) {
    nonEmpty(type.name, "PostgreSQL extension type name");
    nonEmpty(type.identity, "PostgreSQL extension type identity");
    const identity = `type:${typeKey(type)}`;
    if (identities.has(identity)) throw new TypeError(`Duplicate PostgreSQL extension declaration ${identity}`);
    identities.add(identity);
  }
  for (const routine of manifest.routines ?? []) {
    nonEmpty(routine.name, "PostgreSQL extension routine name");
    const identity = `routine:${routineSignature(routine)}`;
    if (identities.has(identity)) throw new TypeError(`Duplicate PostgreSQL extension declaration ${identity}`);
    identities.add(identity);
  }
  for (const operator of manifest.operators ?? []) {
    nonEmpty(operator.name, "PostgreSQL extension operator name");
    if (operator.argumentTypes.length !== 1 && operator.argumentTypes.length !== 2) {
      throw new TypeError("PostgreSQL extension operators require one or two argument types");
    }
    operator.argumentTypes.forEach((type) => {
      nonEmpty(type, "PostgreSQL extension operator argument type");
    });
    nonEmpty(operator.resultType, "PostgreSQL extension operator result type");
    const identity = `operator:${operatorSignature(operator)}`;
    if (identities.has(identity)) throw new TypeError(`Duplicate PostgreSQL extension declaration ${identity}`);
    identities.add(identity);
  }
  for (const cast of manifest.casts ?? []) {
    nonEmpty(cast.sourceType, "PostgreSQL extension cast source type");
    nonEmpty(cast.targetType, "PostgreSQL extension cast target type");
    const identity = `cast:${castSignature(cast)}`;
    if (identities.has(identity)) throw new TypeError(`Duplicate PostgreSQL extension declaration ${identity}`);
    identities.add(identity);
  }
  for (const codec of manifest.codecs ?? []) {
    nonEmpty(codec.databaseType, "PostgreSQL extension codec database type");
    if (typeof codec.decode !== "function") throw new TypeError("PostgreSQL extension codec decode must be a function");
    const identity = `codec:${codec.databaseType.toLowerCase()}`;
    if (identities.has(identity)) throw new TypeError(`Duplicate PostgreSQL extension declaration ${identity}`);
    identities.add(identity);
  }
  return deepFreeze(manifest);
}

function installedExtensions(snapshot: SchemaSnapshot): ReadonlyMap<string, string> {
  return new Map(
    (snapshot.server?.features ?? []).flatMap((feature) => {
      const separator = feature.indexOf(":");
      return separator < 1 ? [] : [[feature.slice(0, separator), feature.slice(separator + 1)] as const];
    }),
  );
}

function issue(message: string, code: PostgresExtensionIssue["code"] = "TSQ407"): PostgresExtensionIssue {
  return { code, message };
}

export function resolvePostgresExtensionManifests(
  source: SchemaSnapshot,
  manifests: readonly PostgresExtensionManifest[],
): ResolvedPostgresExtensions {
  const snapshot = source.formatVersion === 2 ? source : upgradeSchemaSnapshotV1(source);
  const installed = installedExtensions(snapshot);
  const active: { manifest: PostgresExtensionManifest; installedVersion: string }[] = [];
  const issues: PostgresExtensionIssue[] = [];
  const activeNames = new Set<string>();
  for (const input of manifests) {
    const manifest = definePostgresExtensionManifest(input);
    const installedVersion = installed.get(manifest.name);
    if (installedVersion === undefined) continue;
    if (!manifest.supportedVersions.includes(installedVersion)) {
      issues.push(
        issue(
          `PostgreSQL extension ${manifest.name} ${installedVersion} is outside manifest ${manifest.revision}'s supported versions`,
          "TSQ403",
        ),
      );
      continue;
    }
    if (activeNames.has(manifest.name)) {
      issues.push(issue(`Multiple PostgreSQL extension manifests match ${manifest.name} ${installedVersion}`));
      continue;
    }
    activeNames.add(manifest.name);
    active.push({ manifest, installedVersion });
  }

  const types = { ...snapshot.types };
  const routines = Object.fromEntries(
    Object.entries(snapshot.routines).map(([key, overloads]) => [key, [...overloads]]),
  );
  const codecs = new Map<string, PostgresExtensionCodec>();
  const operators: SerializedOperator[] = [];
  const casts: SerializedCast[] = [];
  const operatorIdentities = new Set(postgresExtensionOperators(snapshot).map(operatorSignature));
  const castIdentities = new Set(postgresExtensionCasts(snapshot).map(castSignature));
  const routineIdentities = new Set(Object.values(routines).flat().map(routineSignature));

  for (const { manifest, installedVersion } of active) {
    const declarationExtension = (attributes: Readonly<Record<string, DialectExtensionValue>> | undefined) => ({
      version: installedVersion,
      attributes: {
        ...(attributes ?? {}),
        manifest: manifest.name,
        manifestRevision: manifest.revision,
      },
    });
    for (const type of manifest.types ?? []) {
      const key = typeKey(type);
      if (types[key] !== undefined) {
        issues.push(issue(`PostgreSQL extension type ${key} conflicts with existing snapshot evidence`));
      } else {
        types[key] = {
          ...type,
          extension: declarationExtension(type.extension?.attributes),
        } as TypeSnapshot;
      }
    }
    for (const routine of manifest.routines ?? []) {
      const signature = routineSignature(routine);
      if (routineIdentities.has(signature)) {
        issues.push(issue(`PostgreSQL extension routine ${signature} conflicts with an existing overload`));
        continue;
      }
      routineIdentities.add(signature);
      const key = routineKey(routine);
      routines[key] = [
        ...(routines[key] ?? []),
        {
          ...routine,
          extension: declarationExtension(routine.extension?.attributes),
        },
      ];
    }
    for (const operator of manifest.operators ?? []) {
      const signature = operatorSignature(operator);
      if (operatorIdentities.has(signature)) {
        issues.push(issue(`PostgreSQL extension operator ${signature} is ambiguous across active manifests`));
        continue;
      }
      operatorIdentities.add(signature);
      operators.push(operator);
    }
    for (const cast of manifest.casts ?? []) {
      const signature = castSignature(cast);
      if (
        castIdentities.has(signature) ||
        postgresCatalogCast(cast.sourceType, cast.targetType, snapshot) !== undefined
      ) {
        issues.push(issue(`PostgreSQL extension cast ${signature} conflicts with existing cast evidence`));
        continue;
      }
      castIdentities.add(signature);
      casts.push(cast);
    }
    for (const codec of manifest.codecs ?? []) {
      const key = codec.databaseType.toLowerCase();
      if (codecs.has(key)) issues.push(issue(`PostgreSQL extension codec ${key} is ambiguous across active manifests`));
      else codecs.set(key, codec);
    }
  }

  const attributes: Record<string, DialectExtensionValue> = {
    ...(snapshot.extension?.attributes ?? {}),
    postgresManifests: active.map(({ manifest, installedVersion }) => ({
      name: manifest.name,
      installedVersion,
      revision: manifest.revision,
    })),
    postgresOperators: operators.map(({ name, argumentTypes, resultType }) => ({
      name,
      argumentTypes: [...argumentTypes],
      resultType,
    })) as DialectExtensionValue,
    postgresCasts: casts.map(({ sourceType, targetType, context }) => ({
      sourceType,
      targetType,
      context,
    })) as DialectExtensionValue,
  };
  const resolved = defineSchemaSnapshotV2({
    formatVersion: 2,
    dialect: snapshot.dialect,
    dialectVersion: snapshot.dialectVersion,
    server: snapshot.server,
    namespaces: snapshot.namespaces,
    types,
    relations: snapshot.relations,
    routines,
    ...(snapshot.metadata === undefined ? {} : { metadata: snapshot.metadata }),
    extension: { version: snapshot.extension?.version ?? "1", attributes },
  });
  return Object.freeze({ snapshot: resolved, active: Object.freeze(active), codecs, issues: Object.freeze(issues) });
}

export async function introspectPostgresExtensionManifests(
  source: SchemaSnapshot,
  manifests: readonly PostgresExtensionManifest[],
  client: PostgresExtensionQueryable,
): Promise<ResolvedPostgresExtensions> {
  const selected = resolvePostgresExtensionManifests(source, manifests);
  if (selected.issues.length > 0) throw new PostgresExtensionResolutionError(selected.issues);
  const enriched: PostgresExtensionManifest[] = [];
  for (const { manifest, installedVersion } of selected.active) {
    const contribution = await manifest.introspect?.(client, installedVersion);
    try {
      enriched.push(
        definePostgresExtensionManifest({
          ...manifest,
          ...(contribution?.types === undefined ? {} : { types: [...(manifest.types ?? []), ...contribution.types] }),
          ...(contribution?.routines === undefined
            ? {}
            : { routines: [...(manifest.routines ?? []), ...contribution.routines] }),
        }),
      );
    } catch (error) {
      throw new PostgresExtensionResolutionError([
        issue(
          `PostgreSQL extension ${manifest.name} introspection returned conflicting evidence: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ]);
    }
  }
  const resolved = resolvePostgresExtensionManifests(source, enriched);
  if (resolved.issues.length > 0) throw new PostgresExtensionResolutionError(resolved.issues);
  return resolved;
}

function extensionArray(snapshot: SchemaSnapshot, key: string): readonly unknown[] {
  if (snapshot.formatVersion !== 2) return [];
  const value = snapshot.extension?.attributes[key];
  return Array.isArray(value) ? value : [];
}

export function postgresExtensionOperators(snapshot?: SchemaSnapshot): readonly PostgresExtensionOperator[] {
  if (snapshot === undefined) return [];
  return extensionArray(snapshot, "postgresOperators").flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    if (
      typeof record.name !== "string" ||
      !Array.isArray(record.argumentTypes) ||
      !record.argumentTypes.every((type) => typeof type === "string") ||
      (record.argumentTypes.length !== 1 && record.argumentTypes.length !== 2) ||
      typeof record.resultType !== "string"
    )
      return [];
    return [record as unknown as PostgresExtensionOperator];
  });
}

export function postgresExtensionCasts(snapshot?: SchemaSnapshot): readonly PostgresExtensionCast[] {
  if (snapshot === undefined) return [];
  return extensionArray(snapshot, "postgresCasts").flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    if (
      typeof record.sourceType !== "string" ||
      typeof record.targetType !== "string" ||
      !["explicit", "assignment", "implicit"].includes(String(record.context))
    )
      return [];
    return [record as unknown as PostgresExtensionCast];
  });
}
