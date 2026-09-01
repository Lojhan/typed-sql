import { readFile } from "node:fs/promises";
import type { GeneratedSchemaMetadata, GeneratedSchemaSnapshot, SchemaSnapshot, TypePolicy } from "./model.js";
import { LEGACY_SCHEMA_FORMAT_VERSION, SCHEMA_FORMAT_VERSION } from "./model.js";
import { parseSchemaSnapshotV1 } from "./v1/codec.js";
import { upgradeSchemaSnapshotV1 } from "./v1/upgrade.js";
import { parseSchemaSnapshotV2 } from "./v2/codec.js";

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Dispatches to the isolated v1 or v2 codec. Unversioned historical input is v1. */
export function parseSchemaSnapshot(value: unknown): SchemaSnapshot {
  if (!record(value)) throw new TypeError("Schema snapshot must be an object");
  if (value.formatVersion === SCHEMA_FORMAT_VERSION) {
    // Public v2 values carry derived v1 projections for the typed-sql 2 transition. Strip only
    // those recognized projections so validation is idempotent while every other extra key fails.
    const {
      version: _version,
      tables: _tables,
      enums: _enums,
      domains: _domains,
      functions: _functions,
      ...envelope
    } = value;
    return parseSchemaSnapshotV2(envelope);
  }
  if (value.formatVersion === undefined || value.formatVersion === LEGACY_SCHEMA_FORMAT_VERSION) {
    return parseSchemaSnapshotV1(value);
  }
  throw new TypeError(
    `Unsupported schema.formatVersion ${String(value.formatVersion)}; this release supports formats ${LEGACY_SCHEMA_FORMAT_VERSION} and ${SCHEMA_FORMAT_VERSION}`,
  );
}

/** Validates historical input without silently changing its on-disk format. */
export function migrateSchemaSnapshot(value: unknown): SchemaSnapshot {
  return parseSchemaSnapshot(value);
}

export { upgradeSchemaSnapshotV1 };

export async function loadSchemaSnapshot(path: string): Promise<SchemaSnapshot> {
  const source = await readFile(path, "utf8");
  return parseSchemaSnapshot(JSON.parse(source) as unknown);
}

function parseMetadata(value: unknown): GeneratedSchemaMetadata {
  if (!record(value)) throw new TypeError("schema.metadata must be an object");
  if (typeof value.generatorVersion !== "string")
    throw new TypeError("schema.metadata.generatorVersion must be a string");
  if (typeof value.schemaHash !== "string") throw new TypeError("schema.metadata.schemaHash must be a string");
  if (typeof value.typePolicyHash !== "string") throw new TypeError("schema.metadata.typePolicyHash must be a string");
  if (value.schemaFormat !== undefined && value.schemaFormat !== 1 && value.schemaFormat !== 2) {
    throw new TypeError("schema.metadata.schemaFormat must be 1 or 2");
  }
  return {
    generatorVersion: value.generatorVersion,
    schemaHash: value.schemaHash,
    typePolicyHash: value.typePolicyHash,
    ...(value.schemaFormat === undefined ? {} : { schemaFormat: value.schemaFormat }),
  };
}

export async function loadGeneratedSchemaSnapshot(path: string): Promise<GeneratedSchemaSnapshot> {
  const source = await readFile(path, "utf8");
  const value: unknown = JSON.parse(source);
  if (!record(value)) throw new TypeError("Generated schema snapshot must be an object");
  return { ...parseSchemaSnapshot(value), metadata: parseMetadata(value.metadata) } as GeneratedSchemaSnapshot;
}

export function parseTypePolicy(value: unknown): TypePolicy {
  if (!record(value)) throw new TypeError("Type policy must be an object");
  return value;
}

export async function loadTypePolicy(path: string): Promise<TypePolicy> {
  return parseTypePolicy(JSON.parse(await readFile(path, "utf8")) as unknown);
}
