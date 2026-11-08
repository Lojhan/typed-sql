import type { PostgresNativeSignature } from "../../catalog/native-resolution.js";

/** Trusted offline projection, separate from a qualified native query contract. */
export interface PostgresAnalysisPack {
  readonly formatVersion: 1;
  readonly id: string;
  readonly grammar: "postgres";
  readonly major: number;
  readonly grammarVersion: string;
  readonly catalogRevision: string;
  readonly sourceDigest: string;
  readonly facets: readonly (
    | "projected-routine-signatures"
    | "projected-volatility"
    | "projected-null-input-behavior"
  )[];
  readonly dependencies: readonly { readonly id: string; readonly digest: string }[];
  readonly signatures: readonly PostgresNativeSignature[];
}
function freeze<Value>(value: Value, seen = new Set<object>()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}
export function definePostgresAnalysisPack(pack: PostgresAnalysisPack): PostgresAnalysisPack {
  if (
    pack.formatVersion !== 1 ||
    pack.grammar !== "postgres" ||
    !Number.isSafeInteger(pack.major) ||
    pack.major < 1 ||
    !pack.id ||
    !pack.grammarVersion ||
    !/^sha256:[a-f\d]{64}$/u.test(pack.catalogRevision) ||
    !/^sha256:[a-f\d]{64}$/u.test(pack.sourceDigest)
  )
    throw new TypeError("Invalid PostgreSQL offline pack metadata");
  if (
    pack.dependencies.length !== 1 ||
    pack.dependencies[0]?.id !== `postgres/core/${pack.major}` ||
    !/^sha256:[a-f\d]{64}$/u.test(pack.dependencies[0].digest)
  )
    throw new TypeError("This PostgreSQL offline pack requires unsupported dependencies");
  return freeze(pack);
}
