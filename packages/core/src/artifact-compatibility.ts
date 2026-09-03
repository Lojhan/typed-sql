export const ARTIFACT_COMPATIBILITY_IDENTITY_FORMAT_VERSION = 1 as const;
export const CORE_ARTIFACT_COMPATIBILITY_VERSION = "typed-sql-core-v1" as const;

export type ArtifactCompatibilityOutcome =
  | "compatible"
  | "requires-reanalysis"
  | "requires-reintrospection"
  | "unsupported-target"
  | "corrupt-artifact";

export interface ArtifactCompatibilityIdentity {
  readonly formatVersion: typeof ARTIFACT_COMPATIBILITY_IDENTITY_FORMAT_VERSION;
  readonly artifact: {
    readonly kind: string;
    readonly version: string;
    readonly algorithm?: string;
  };
  readonly producer: {
    readonly core: string;
    readonly compiler?: string;
  };
  readonly grammar: {
    readonly id: string;
    readonly version: string;
    readonly catalogRevision?: string;
    readonly capabilityFingerprint: string;
  };
  readonly server?: {
    readonly product: string;
    readonly version: string;
    readonly capabilityFingerprint: string;
  };
  readonly schema: {
    readonly formatVersion: 1 | 2;
    readonly hash: string;
  };
  readonly typePolicyHash: string;
  readonly runtimeSettingsHash?: string;
  readonly source?: {
    readonly hash: string;
    readonly query?: string;
  };
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface ArtifactCompatibilityAssessment {
  readonly outcome: ArtifactCompatibilityOutcome;
  readonly reasons: readonly string[];
  readonly candidate?: ArtifactCompatibilityIdentity;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new TypeError(`${path} contains unknown fields: ${unknown.sort().join(", ")}`);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${path} must be a non-empty string without null bytes`);
  }
  return value;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!record(value) || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value;
}

function jsonValue(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${path}[${index}]`));
  const source = object(value, path);
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, jsonValue(source[key], `${path}.${key}`)]),
  );
}

export function parseArtifactCompatibilityIdentity(value: unknown): ArtifactCompatibilityIdentity {
  const root = object(value, "artifact compatibility identity");
  keys(
    root,
    [
      "formatVersion",
      "artifact",
      "producer",
      "grammar",
      "server",
      "schema",
      "typePolicyHash",
      "runtimeSettingsHash",
      "source",
      "extensions",
    ],
    "artifact compatibility identity",
  );
  if (root.formatVersion !== ARTIFACT_COMPATIBILITY_IDENTITY_FORMAT_VERSION) {
    throw new TypeError(`Unsupported artifact compatibility identity format ${String(root.formatVersion)}`);
  }
  const artifact = object(root.artifact, "identity.artifact");
  keys(artifact, ["kind", "version", "algorithm"], "identity.artifact");
  const producer = object(root.producer, "identity.producer");
  keys(producer, ["core", "compiler"], "identity.producer");
  const grammar = object(root.grammar, "identity.grammar");
  keys(grammar, ["id", "version", "catalogRevision", "capabilityFingerprint"], "identity.grammar");
  const schema = object(root.schema, "identity.schema");
  keys(schema, ["formatVersion", "hash"], "identity.schema");
  if (schema.formatVersion !== 1 && schema.formatVersion !== 2) {
    throw new TypeError("identity.schema.formatVersion must be 1 or 2");
  }
  const server = root.server === undefined ? undefined : object(root.server, "identity.server");
  if (server !== undefined) keys(server, ["product", "version", "capabilityFingerprint"], "identity.server");
  const source = root.source === undefined ? undefined : object(root.source, "identity.source");
  if (source !== undefined) keys(source, ["hash", "query"], "identity.source");
  const extensions =
    root.extensions === undefined
      ? undefined
      : (jsonValue(object(root.extensions, "identity.extensions"), "identity.extensions") as Readonly<
          Record<string, unknown>
        >);
  return Object.freeze({
    formatVersion: ARTIFACT_COMPATIBILITY_IDENTITY_FORMAT_VERSION,
    artifact: Object.freeze({
      kind: text(artifact.kind, "identity.artifact.kind"),
      version: text(artifact.version, "identity.artifact.version"),
      ...(artifact.algorithm === undefined
        ? {}
        : { algorithm: text(artifact.algorithm, "identity.artifact.algorithm") }),
    }),
    producer: Object.freeze({
      core: text(producer.core, "identity.producer.core"),
      ...(producer.compiler === undefined ? {} : { compiler: text(producer.compiler, "identity.producer.compiler") }),
    }),
    grammar: Object.freeze({
      id: text(grammar.id, "identity.grammar.id"),
      version: text(grammar.version, "identity.grammar.version"),
      ...(grammar.catalogRevision === undefined
        ? {}
        : { catalogRevision: text(grammar.catalogRevision, "identity.grammar.catalogRevision") }),
      capabilityFingerprint: text(grammar.capabilityFingerprint, "identity.grammar.capabilityFingerprint"),
    }),
    ...(server === undefined
      ? {}
      : {
          server: Object.freeze({
            product: text(server.product, "identity.server.product"),
            version: text(server.version, "identity.server.version"),
            capabilityFingerprint: text(server.capabilityFingerprint, "identity.server.capabilityFingerprint"),
          }),
        }),
    schema: Object.freeze({
      formatVersion: schema.formatVersion,
      hash: text(schema.hash, "identity.schema.hash"),
    }),
    typePolicyHash: text(root.typePolicyHash, "identity.typePolicyHash"),
    ...(root.runtimeSettingsHash === undefined
      ? {}
      : { runtimeSettingsHash: text(root.runtimeSettingsHash, "identity.runtimeSettingsHash") }),
    ...(source === undefined
      ? {}
      : {
          source: Object.freeze({
            hash: text(source.hash, "identity.source.hash"),
            ...(source.query === undefined ? {} : { query: text(source.query, "identity.source.query") }),
          }),
        }),
    ...(extensions === undefined ? {} : { extensions: Object.freeze(extensions) }),
  });
}

export function serializeArtifactCompatibilityIdentity(identity: ArtifactCompatibilityIdentity): string {
  return `${JSON.stringify(parseArtifactCompatibilityIdentity(identity), null, 2)}\n`;
}

export function assessArtifactCompatibility(
  referenceValue: ArtifactCompatibilityIdentity,
  candidateValue: unknown,
): ArtifactCompatibilityAssessment {
  const reference = parseArtifactCompatibilityIdentity(referenceValue);
  let candidate: ArtifactCompatibilityIdentity;
  try {
    candidate = parseArtifactCompatibilityIdentity(candidateValue);
  } catch {
    return Object.freeze({ outcome: "corrupt-artifact", reasons: Object.freeze(["identity-invalid"]) });
  }
  const unsupported: string[] = [];
  const reintrospection: string[] = [];
  const reanalysis: string[] = [];
  const compare = (left: string | undefined, right: string | undefined, reason: string, target: string[]) => {
    if (left !== undefined && left !== right) target.push(reason);
  };
  compare(reference.artifact.kind, candidate.artifact.kind, "artifact-kind-changed", unsupported);
  compare(reference.artifact.version, candidate.artifact.version, "artifact-version-changed", unsupported);
  compare(reference.artifact.algorithm, candidate.artifact.algorithm, "artifact-algorithm-changed", unsupported);
  compare(reference.producer.core, candidate.producer.core, "core-compatibility-changed", unsupported);
  compare(reference.producer.compiler, candidate.producer.compiler, "compiler-compatibility-changed", reanalysis);
  compare(reference.grammar.id, candidate.grammar.id, "grammar-changed", unsupported);
  compare(reference.grammar.version, candidate.grammar.version, "grammar-version-changed", reintrospection);
  compare(
    reference.grammar.catalogRevision,
    candidate.grammar.catalogRevision,
    "catalog-revision-changed",
    reintrospection,
  );
  compare(
    reference.grammar.capabilityFingerprint,
    candidate.grammar.capabilityFingerprint,
    "grammar-capabilities-changed",
    reintrospection,
  );
  compare(reference.server?.product, candidate.server?.product, "server-product-changed", reintrospection);
  compare(reference.server?.version, candidate.server?.version, "server-version-changed", reintrospection);
  compare(
    reference.server?.capabilityFingerprint,
    candidate.server?.capabilityFingerprint,
    "server-capabilities-changed",
    reintrospection,
  );
  if (reference.schema.formatVersion !== candidate.schema.formatVersion) reintrospection.push("schema-format-changed");
  compare(reference.schema.hash, candidate.schema.hash, "schema-changed", reanalysis);
  compare(reference.typePolicyHash, candidate.typePolicyHash, "type-policy-changed", reanalysis);
  compare(reference.runtimeSettingsHash, candidate.runtimeSettingsHash, "runtime-settings-changed", reintrospection);
  compare(reference.source?.hash, candidate.source?.hash, "source-changed", reanalysis);
  compare(reference.source?.query, candidate.source?.query, "query-changed", reanalysis);
  const [outcome, reasons] =
    unsupported.length > 0
      ? (["unsupported-target", unsupported] as const)
      : reintrospection.length > 0
        ? (["requires-reintrospection", reintrospection] as const)
        : reanalysis.length > 0
          ? (["requires-reanalysis", reanalysis] as const)
          : (["compatible", []] as const);
  return Object.freeze({ outcome, reasons: Object.freeze(reasons), candidate });
}
