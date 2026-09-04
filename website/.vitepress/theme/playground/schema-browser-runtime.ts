const unsupportedFingerprint = `sha256:${"0".repeat(64)}`;

/** The homepage playground accepts v2 schema input only. */
export function upgradeSchemaSnapshotV1(): never {
  throw new TypeError("The browser playground requires a schema-v2 snapshot.");
}

/** Expression-index evidence is outside the playground DDL subset and therefore never matches. */
export function fingerprintSchemaExpression(): string {
  return unsupportedFingerprint;
}
