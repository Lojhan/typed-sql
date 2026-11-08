import type { RoutineSnapshot, SchemaSnapshotV2, TypeSnapshot } from "@typed-sql/schema";

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
