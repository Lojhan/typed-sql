import type { SchemaSnapshot } from "@typed-sql/schema";
import { POSTGRES_SUPPORT_POLICY, parsePostgresMajor } from "../support.js";
import { nativeSignatures } from "./generated/native.js";

export interface PostgresNativeSignature {
  readonly name: string;
  readonly namespace: string | null;
  readonly identity: string;
  readonly kind: string;
  readonly arguments: readonly {
    readonly name: string | null;
    readonly nativeType: string;
    readonly mode: string;
    readonly hasDefault: boolean | null;
  }[];
  readonly result: string | null;
  readonly returnsSet: boolean | null;
  readonly variadicNativeType: string | null;
  readonly volatility: string | null;
  readonly strict: boolean | null;
}

const indexes = new Map<number, ReadonlyMap<string, readonly PostgresNativeSignature[]>>();

/** Native overloads remain complete even when a return type has no decoding policy. */
export function postgresNativeOverloads(
  name: string,
  schema: SchemaSnapshot,
  namespace?: string,
): readonly PostgresNativeSignature[] {
  if (namespace !== undefined && namespace !== "pg_catalog") return [];
  const version = schema.server?.versionKey ?? schema.version;
  const major = version === undefined ? POSTGRES_SUPPORT_POLICY.stableMajors[0] : parsePostgresMajor(version);
  if (major === undefined || nativeSignatures[major] === undefined) return [];
  let index = indexes.get(major);
  if (!index) {
    const rows = new Map<string, PostgresNativeSignature[]>();
    for (const signature of nativeSignatures[major]!) {
      const bucket = rows.get(signature.name) ?? [];
      bucket.push(signature);
      rows.set(signature.name, bucket);
    }
    index = rows;
    indexes.set(major, index);
  }
  return index.get(name) ?? [];
}

/** Bind formal parameters without inventing optional arguments or wildcard parameter types. */
export function postgresNativeArguments(
  signature: PostgresNativeSignature,
  actualTypes: readonly (string | undefined)[],
  names?: readonly (string | undefined)[],
  explicitVariadic = false,
): readonly string[] | undefined {
  const inputs = signature.arguments.filter((argument) => ["i", "b", "v"].includes(argument.mode));
  const variadic = inputs.at(-1)?.mode === "v";
  if (explicitVariadic && !variadic) return undefined;
  let expected: readonly string[];
  if (names !== undefined) {
    if (names.length !== actualTypes.length) return undefined;
    // Expanded elements have no formal names. Explicit VARIADIC binds the array itself.
    if (variadic && !explicitVariadic) return undefined;
    const used = new Set<number>();
    let positional = 0;
    let named = false;
    const mapped = names.map((name) => {
      if (name === undefined && named) return undefined;
      if (name !== undefined) named = true;
      const index = name === undefined ? positional++ : inputs.findIndex((argument) => argument.name === name);
      if (index < 0 || index >= inputs.length || used.has(index)) return undefined;
      used.add(index);
      return inputs[index]!.nativeType;
    });
    if (
      mapped.some((type) => type === undefined) ||
      inputs.some((argument, index) => !used.has(index) && argument.hasDefault !== true)
    )
      return undefined;
    expected = mapped as readonly string[];
  } else if (variadic && !explicitVariadic) {
    const fixed = inputs.slice(0, -1);
    if (
      actualTypes.length < inputs.length &&
      inputs.slice(actualTypes.length).some((argument) => argument.hasDefault !== true)
    )
      return undefined;
    const element = signature.variadicNativeType;
    if (!element) return undefined;
    expected = actualTypes.map((_type, index) => (index < fixed.length ? fixed[index]!.nativeType : element));
  } else {
    if (
      actualTypes.length > inputs.length ||
      (explicitVariadic && actualTypes.length !== inputs.length) ||
      inputs.slice(actualTypes.length).some((argument) => argument.hasDefault !== true)
    )
      return undefined;
    expected = inputs.slice(0, actualTypes.length).map((argument) => argument.nativeType);
  }
  const bound = expected.map((type, index) => {
    if (type !== '"any"' && type !== "any") return type;
    const actual = actualTypes[index];
    if (explicitVariadic && !actual?.endsWith("[]")) return undefined;
    return actual;
  });
  return bound.some((type) => type === undefined) ? undefined : (bound as readonly string[]);
}
