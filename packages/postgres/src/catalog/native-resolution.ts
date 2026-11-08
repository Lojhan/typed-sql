import { bindRoutineArguments } from "@typed-sql/core";
import type { SchemaSnapshot } from "@typed-sql/schema";
import { POSTGRES_SUPPORT_POLICY, parsePostgresMajor } from "../support.js";

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

export type PostgresNativeCatalog = Readonly<Record<number, readonly PostgresNativeSignature[]>>;
const indexes = new WeakMap<
  readonly PostgresNativeSignature[],
  ReadonlyMap<string, readonly PostgresNativeSignature[]>
>();

/** Native overloads remain complete even when a return type has no decoding policy. */
export function postgresNativeOverloads(
  name: string,
  schema: SchemaSnapshot,
  namespace: string | undefined,
  nativeSignatures: PostgresNativeCatalog,
): readonly PostgresNativeSignature[] {
  if (namespace !== undefined && namespace !== "pg_catalog") return [];
  const version = schema.server?.versionKey ?? schema.version;
  const major = version === undefined ? POSTGRES_SUPPORT_POLICY.stableMajors[0] : parsePostgresMajor(version);
  if (major === undefined || nativeSignatures[major] === undefined) return [];
  const signatures = nativeSignatures[major]!;
  let index = indexes.get(signatures);
  if (!index) {
    const rows = new Map<string, PostgresNativeSignature[]>();
    for (const signature of signatures) {
      const bucket = rows.get(signature.name) ?? [];
      bucket.push(signature);
      rows.set(signature.name, bucket);
    }
    index = rows;
    indexes.set(signatures, index);
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
  const bindings = bindRoutineArguments(
    inputs.map((argument) => ({
      ...(argument.name === null ? {} : { name: argument.name }),
      optional: argument.hasDefault === true,
      variadic: argument.mode === "v",
    })),
    {
      argumentCount: actualTypes.length,
      ...(names === undefined ? {} : { names }),
      variadic: explicitVariadic ? "explicit" : "expanded",
    },
    { positionalAfterNamed: false, expandedVariadicNames: false, minimumVariadicElements: 1 },
  );
  if (!bindings) return undefined;
  const expected = bindings.map((binding) =>
    binding.variadicElement ? signature.variadicNativeType : inputs[binding.parameterIndex]!.nativeType,
  );
  const bound = expected.map((type, index) => {
    if (type === null) return undefined;
    if (type !== '"any"' && type !== "any") return type;
    const actual = actualTypes[index];
    if (explicitVariadic && !actual?.endsWith("[]")) return undefined;
    return actual;
  });
  return bound.some((type) => type === undefined) ? undefined : (bound as readonly string[]);
}
