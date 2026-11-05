import { parseSchemaSnapshotV2, schemaSnapshotV2Envelope } from "../../../../packages/schema/src/v2/codec.js";
import type { SchemaSnapshotV2 } from "../../../../packages/schema/src/v2/model.js";

export { defineSchemaSnapshotV2 } from "../../../../packages/schema/src/v2/codec.js";

/** Grammar roots validate the same portable v2 envelope without loading Node's schema loader. */
export function parseSchemaSnapshot(value: unknown): SchemaSnapshotV2 {
  if (typeof value !== "object" || value === null || !("formatVersion" in value) || value.formatVersion !== 2)
    throw new TypeError("The browser playground requires a schema-v2 snapshot.");
  return parseSchemaSnapshotV2(schemaSnapshotV2Envelope(value as SchemaSnapshotV2));
}

const unsupportedFingerprint = `sha256:${"0".repeat(64)}`;

/** The homepage playground accepts v2 schema input only. */
export function upgradeSchemaSnapshotV1(): never {
  throw new TypeError("The browser playground requires a schema-v2 snapshot.");
}

/** Expression-index evidence is outside the playground DDL subset and therefore never matches. */
export function fingerprintSchemaExpression(): string {
  return unsupportedFingerprint;
}
