export type CanonicalMetadata<Value> = Value extends bigint
  ? string
  : Value extends readonly unknown[]
    ? { [Index in keyof Value]: CanonicalMetadata<Value[Index]> }
    : Value extends object
      ? { [Key in keyof Value]: CanonicalMetadata<Value[Key]> }
      : Value;

/** Recursively canonicalizes plain metadata records, arrays and bigint values. */
export declare function canonical<Value>(value: Value): CanonicalMetadata<Value>;
export declare function hash(value: unknown): `sha256:${string}`;
