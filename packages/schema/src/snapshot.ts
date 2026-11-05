import type { SchemaSnapshot } from "./model.js";
import { LEGACY_SCHEMA_FORMAT_VERSION, SCHEMA_FORMAT_VERSION } from "./model.js";
import { parseSchemaSnapshotV1 } from "./v1/codec.js";
import { parseSchemaSnapshotV2 } from "./v2/codec.js";

export type { SchemaSnapshot, SchemaSnapshotV1, SchemaSnapshotV2 } from "./model.js";
export { LEGACY_SCHEMA_FORMAT_VERSION, SCHEMA_FORMAT_VERSION } from "./model.js";
export { defineSchemaSnapshotV2 } from "./v2/codec.js";

/** Validate portable snapshot data without loading filesystem or generation services. */
export function parseSchemaSnapshot(value: unknown): SchemaSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Schema snapshot must be an object");
  const input = value as Readonly<Record<string, unknown>>;
  if (input.formatVersion === SCHEMA_FORMAT_VERSION) {
    // Public v2 values carry derived v1 projections during the typed-sql 2 transition.
    // Strip only those recognized projections; every other extra key still fails.
    const {
      version: _version,
      tables: _tables,
      enums: _enums,
      domains: _domains,
      functions: _functions,
      ...envelope
    } = input;
    return parseSchemaSnapshotV2(envelope);
  }
  if (input.formatVersion === undefined || input.formatVersion === LEGACY_SCHEMA_FORMAT_VERSION)
    return parseSchemaSnapshotV1(input);
  throw new TypeError(
    `Unsupported schema.formatVersion ${String(input.formatVersion)}; this release supports formats ${LEGACY_SCHEMA_FORMAT_VERSION} and ${SCHEMA_FORMAT_VERSION}`,
  );
}

/** Validate historical input without silently changing its on-disk format. */
export function migrateSchemaSnapshot(value: unknown): SchemaSnapshot {
  return parseSchemaSnapshot(value);
}
