import { calculateSchemaHash, calculateTypePolicyHash, defineSchemaSnapshotV2 } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import {
  POSTGRES_DIALECT_VERSION,
  PostgresRuntimeCompatibilityError,
  postgresCoreCatalog,
  postgresServerEvidence,
  validatePostgresRuntimeCompatibility,
} from "../src/index.js";

const server = postgresServerEvidence("18.6", ["plpgsql:1.0"], {
  searchPath: '"$user", public',
  standardConformingStrings: "on",
  visibilityScope: "current-role",
});

function snapshot() {
  return defineSchemaSnapshotV2({
    formatVersion: 2,
    dialect: "postgres",
    dialectVersion: POSTGRES_DIALECT_VERSION,
    server,
    namespaces: {},
    types: {},
    relations: {},
    routines: {},
    extension: {
      version: "1",
      attributes: { catalogRevision: postgresCoreCatalog(18)!.revision },
    },
  });
}

await describe("PostgreSQL runtime compatibility", async () => {
  await it("accepts matching grammar, server, extension, setting, catalog, and policy evidence", () => {
    validatePostgresRuntimeCompatibility(snapshot(), server);
  });

  await it("requires a PostgreSQL v2 artifact", () => {
    strict.throws(
      () => validatePostgresRuntimeCompatibility({ formatVersion: 1, dialect: "postgres", tables: {} }, server),
      (error: unknown) => error instanceof PostgresRuntimeCompatibilityError && error.reason === "artifact",
    );
  });

  await it("classifies fail-closed compatibility mismatches", () => {
    const cases = [
      [{ ...snapshot(), dialectVersion: "future" }, server, "grammar-version"],
      [snapshot(), postgresServerEvidence("17.11", ["plpgsql:1.0"], server.settings), "server-version"],
      [snapshot(), postgresServerEvidence("18.6", [], server.settings), "extensions"],
      [
        snapshot(),
        postgresServerEvidence("18.6", ["plpgsql:1.0"], { ...server.settings, searchPath: "app" }),
        "search-path",
      ],
      [
        { ...snapshot(), extension: { version: "1", attributes: { catalogRevision: "stale" } } },
        server,
        "catalog-revision",
      ],
    ] as const;
    for (const [artifact, actual, reason] of cases) {
      strict.throws(
        () => validatePostgresRuntimeCompatibility(artifact, actual),
        (error: unknown) =>
          error instanceof PostgresRuntimeCompatibilityError &&
          error.code === "POSTGRES_RUNTIME_INCOMPATIBLE" &&
          error.reason === reason,
      );
    }
  });

  await it("validates embedded schema and type-policy identities", () => {
    const base = snapshot();
    const generated = {
      formatVersion: 2,
      dialect: base.dialect,
      dialectVersion: base.dialectVersion,
      server: base.server,
      namespaces: base.namespaces,
      types: base.types,
      relations: base.relations,
      routines: base.routines,
      extension: base.extension,
      metadata: {
        generatorVersion: "test",
        schemaFormat: 2,
        schemaHash: calculateSchemaHash(base),
        typePolicyHash: calculateTypePolicyHash({}),
      },
    } as const;
    validatePostgresRuntimeCompatibility(generated, server);
    strict.throws(
      () =>
        validatePostgresRuntimeCompatibility(
          { ...generated, metadata: { ...generated.metadata!, typePolicyHash: "0".repeat(64) } },
          server,
        ),
      (error: unknown) => error instanceof PostgresRuntimeCompatibilityError && error.reason === "type-policy",
    );
    strict.throws(
      () =>
        validatePostgresRuntimeCompatibility(
          { ...generated, metadata: { ...generated.metadata!, schemaHash: "0".repeat(64) } },
          server,
        ),
      (error: unknown) => error instanceof PostgresRuntimeCompatibilityError && error.reason === "artifact",
    );
  });
});
