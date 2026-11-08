/** Canonicalizes metadata keys and bigint values without asserting a narrower input shape. */
export declare function canonical(value: unknown): unknown;
export declare function hash(value: unknown): `sha256:${string}`;
