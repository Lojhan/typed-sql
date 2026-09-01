import { describe, it, strict } from "poku";
import { type SchemaSnapshot, upgradeSchemaSnapshotV1 } from "../../schema/src/index.js";
import {
  definePostgresExtensionManifest,
  introspectPostgresExtensionManifests,
  POSTGRES_EXTENSION_MANIFEST_FORMAT_VERSION,
  postgres,
  postgresServerEvidence,
  resolvePostgresExtensionManifests,
} from "../src/index.js";

const base = {
  ...upgradeSchemaSnapshotV1({
    formatVersion: 1,
    dialect: "postgres",
    tables: {
      items: {
        name: "items",
        columns: {
          embedding: {
            name: "embedding",
            databaseType: "vector",
            tsType: "readonly number[]",
            nullable: false,
          },
        },
      },
    },
  }),
  dialect: "postgres",
  server: postgresServerEvidence("18.6", ["vector:0.7.4"], { standardConformingStrings: "on" }),
} as const satisfies SchemaSnapshot;

const vectorType = {
  kind: "scalar",
  name: "vector",
  schema: "public",
  identity: "extension:vector.vector",
  databaseType: "vector",
  tsType: "readonly number[]",
} as const;

const distanceRoutine = {
  name: "cosine_distance",
  schema: "public",
  identity: "extension:vector.cosine_distance(vector,vector)",
  kind: "function",
  arguments: [
    {
      mode: "in",
      typeIdentity: vectorType.identity,
      databaseType: "vector",
      tsType: "readonly number[]",
      default: "none",
    },
    {
      mode: "in",
      typeIdentity: vectorType.identity,
      databaseType: "vector",
      tsType: "readonly number[]",
      default: "none",
    },
  ],
  result: {
    kind: "scalar",
    typeIdentity: "pg:701",
    databaseType: "double precision",
    tsType: "number",
    nullable: false,
  },
  volatility: "immutable",
  deterministic: true,
  dataAccess: "none",
  nullInput: "strict",
} as const;

const vectorManifest = definePostgresExtensionManifest({
  formatVersion: POSTGRES_EXTENSION_MANIFEST_FORMAT_VERSION,
  name: "vector",
  supportedVersions: ["0.7.4", "0.8.0"],
  revision: "1.0.0",
  types: [vectorType],
  routines: [distanceRoutine],
  operators: [
    { name: "&&", argumentTypes: ["vector", "vector"], resultType: "boolean" },
    { name: "~", argumentTypes: ["vector"], resultType: "vector" },
  ],
  casts: [{ sourceType: "vector", targetType: "bytea", context: "explicit" }],
  codecs: [
    {
      databaseType: "vector",
      decode(value) {
        return String(value).slice(1, -1).split(",").map(Number);
      },
    },
  ],
  async introspect() {
    return { types: [vectorType], routines: [distanceRoutine] };
  },
});

await describe("PostgreSQL extension manifests", async () => {
  await it("resolves public third-party type, routine, operator, cast, and codec declarations", () => {
    strict.ok(Object.isFrozen(vectorManifest));
    strict.ok(Object.isFrozen(vectorManifest.operators));
    const resolved = resolvePostgresExtensionManifests(base, [vectorManifest]);
    strict.deepStrictEqual(resolved.issues, []);
    strict.strictEqual(resolved.active[0]?.installedVersion, "0.7.4");
    strict.strictEqual(resolved.snapshot.types.vector?.identity, vectorType.identity);
    strict.deepStrictEqual(resolved.snapshot.types.vector?.extension, {
      version: "0.7.4",
      attributes: { manifest: "vector", manifestRevision: "1.0.0" },
    });
    strict.strictEqual(resolved.snapshot.routines.cosine_distance?.length, 1);
    strict.deepStrictEqual(resolved.codecs.get("vector")?.decode("[1,2.5]"), [1, 2.5]);

    const analysis = postgres({ extensions: [vectorManifest] }).analyze(
      "SELECT cosine_distance(embedding, $1) AS distance, embedding && $2 AS overlaps, ~embedding AS inverted, embedding::bytea AS encoded FROM items",
      base,
    );
    strict.deepStrictEqual(analysis.diagnostics, []);
    strict.deepStrictEqual(
      analysis.columns.map(({ name, databaseType, tsType, nullable }) => ({ name, databaseType, tsType, nullable })),
      [
        { name: "distance", databaseType: "double precision", tsType: "number", nullable: false },
        { name: "overlaps", databaseType: "boolean", tsType: "boolean", nullable: false },
        { name: "inverted", databaseType: "vector", tsType: "readonly number[]", nullable: false },
        { name: "encoded", databaseType: "bytea", tsType: "Uint8Array", nullable: false },
      ],
    );
    strict.deepStrictEqual(
      analysis.parameters.map(({ databaseType, tsType }) => ({ databaseType, tsType })),
      [
        { databaseType: "vector", tsType: "readonly number[]" },
        { databaseType: "vector", tsType: "readonly number[]" },
      ],
    );
  });

  await it("fails closed on unsupported versions and conflicting active declarations", () => {
    const unsupported = {
      ...base,
      server: postgresServerEvidence("18.6", ["vector:9.0.0"], { standardConformingStrings: "on" }),
    } as const satisfies SchemaSnapshot;
    strict.deepStrictEqual(
      resolvePostgresExtensionManifests(unsupported, [vectorManifest]).issues.map(({ code }) => code),
      ["TSQ403"],
    );

    const conflict = definePostgresExtensionManifest({
      formatVersion: 1,
      name: "vector_tools",
      supportedVersions: ["1.0.0"],
      revision: "1",
      operators: [{ name: "&&", argumentTypes: ["vector", "vector"], resultType: "integer" }],
    });
    const conflictingSnapshot = {
      ...base,
      server: postgresServerEvidence("18.6", ["vector:0.7.4", "vector_tools:1.0.0"], {
        standardConformingStrings: "on",
      }),
    } as const satisfies SchemaSnapshot;
    const analysis = postgres({ extensions: [vectorManifest, conflict] }).analyze(
      "SELECT embedding && embedding AS overlap FROM items",
      conflictingSnapshot,
    );
    strict.ok(analysis.diagnostics.some(({ code }) => code === "TSQ407"));
    strict.strictEqual(analysis.semantics.operation.value, "unknown");

    const duplicated = resolvePostgresExtensionManifests(base, [vectorManifest, vectorManifest]);
    strict.ok(duplicated.issues.some(({ message }) => message.includes("Multiple PostgreSQL extension manifests")));
    const reapplied = resolvePostgresExtensionManifests(resolvedSnapshot(vectorManifest), [vectorManifest]);
    strict.ok(reapplied.issues.some(({ message }) => message.includes("type vector conflicts")));
    strict.ok(reapplied.issues.some(({ message }) => message.includes("routine cosine_distance")));
  });

  await it("normalizes introspection conflicts into stable extension issues", async () => {
    const conflictingIntrospection = definePostgresExtensionManifest({
      formatVersion: 1,
      name: "vector",
      supportedVersions: ["0.7.4"],
      revision: "introspection",
      types: [vectorType],
      async introspect() {
        return { types: [vectorType] };
      },
    });
    await strict.rejects(
      () =>
        introspectPostgresExtensionManifests(base, [conflictingIntrospection], {
          async query() {
            return { rows: [] };
          },
        }),
      (error: unknown) =>
        error instanceof Error && error.message.includes("TSQ407") && error.message.includes("introspection"),
    );
  });

  await it("rejects malformed and duplicate manifest declarations", () => {
    strict.throws(
      () =>
        definePostgresExtensionManifest({
          ...vectorManifest,
          supportedVersions: ["0.8.0", "0.7.4"],
        }),
      /sorted and unique/u,
    );
    strict.throws(
      () =>
        definePostgresExtensionManifest({
          formatVersion: 1,
          name: "vector",
          supportedVersions: ["0.7.4"],
          revision: "duplicate",
          casts: [
            { sourceType: "integer", targetType: "numeric", context: "implicit" },
            { sourceType: "integer", targetType: "numeric", context: "explicit" },
          ],
        }),
      /Duplicate PostgreSQL extension declaration/u,
    );
  });
});

function resolvedSnapshot(manifest: typeof vectorManifest): SchemaSnapshot {
  return resolvePostgresExtensionManifests(base, [manifest]).snapshot;
}
