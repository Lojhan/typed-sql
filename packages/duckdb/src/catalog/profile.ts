import type { DuckDBBuiltinSignature, DuckDBFormalParameter } from "./types.js";

export type { DuckDBBuiltinSignature } from "./types.js";

type FormalNames = readonly (readonly (string | null)[])[];
const formalNames = new WeakMap<DuckDBBuiltinSignature, FormalNames>();
const literalConstraints = new WeakMap<DuckDBBuiltinSignature, readonly number[]>();
const parameterBindings = new WeakMap<DuckDBBuiltinSignature, readonly (readonly DuckDBFormalParameter[])[]>();
const noLiteralConstraints: readonly number[] = Object.freeze([]);
function owned(
  values: readonly DuckDBBuiltinSignature[],
  names: readonly FormalNames[],
  constraints: Readonly<Record<number, readonly number[]>>,
  parameters: readonly (readonly (readonly DuckDBFormalParameter[])[])[],
): readonly DuckDBBuiltinSignature[] {
  if (values.length !== names.length || values.length !== parameters.length)
    throw new TypeError("DuckDB parameter inventory does not match signatures");
  return Object.freeze(
    values.map((value, index) => {
      const signature = Object.freeze([
        value[0],
        value[1],
        Object.freeze([...value[2]]),
        value[3],
        value[4],
        value[5],
        value[6],
      ]) as DuckDBBuiltinSignature;
      if (constraints[index]?.length) literalConstraints.set(signature, Object.freeze([...constraints[index]!]));
      formalNames.set(signature, Object.freeze(names[index]!.map((row) => Object.freeze([...row]))));
      parameterBindings.set(
        signature,
        Object.freeze(
          parameters[index]!.map((row) => Object.freeze(row.map((parameter) => Object.freeze({ ...parameter })))),
        ),
      );
      return signature;
    }),
  );
}

export interface DuckDBCatalogData {
  readonly version: string;
  readonly signatures: readonly DuckDBBuiltinSignature[];
  readonly parameterNames: readonly FormalNames[];
  readonly nonNullLiteralArguments: Readonly<Record<number, readonly number[]>>;
  readonly parameterBindings: readonly (readonly (readonly DuckDBFormalParameter[])[])[];
  readonly implicitCasts: readonly (readonly [string, string])[];
  readonly namedArgumentBinding?: {
    readonly parameterModes: "version-policy" | "vendor-signatures";
    readonly scalar: "labels" | "formal";
    readonly macro: "labels" | "formal";
    readonly overrides: Readonly<Record<string, "labels" | "formal">>;
  };
  readonly keywordInvocationForms: readonly string[];
  readonly commonTypes: Readonly<Record<string, string | null>>;
  readonly expressionTypes: Readonly<Record<string, string | null>>;
  readonly explicitInvocationArity: Readonly<Record<string, number>>;
  readonly tableConstantNullTyping: string;
}
/** An immutable profile with indexes owned by this catalog instance. */
export class DuckDBCatalog {
  readonly version: string;
  readonly signatures: readonly DuckDBBuiltinSignature[];
  readonly commonTypes: Readonly<Record<string, string | null>>;
  readonly expressionTypes: Readonly<Record<string, string | null>>;
  readonly explicitInvocationArity: Readonly<Record<string, number>>;
  readonly tableConstantNullTyping: string;
  readonly namedArgumentBinding: DuckDBCatalogData["namedArgumentBinding"];
  readonly keywordInvocationForms: readonly string[];
  readonly #casts: ReadonlySet<string>;
  #index: ReadonlyMap<string, readonly DuckDBBuiltinSignature[]> | undefined;
  constructor(data: DuckDBCatalogData) {
    this.version = data.version;
    this.signatures = owned(data.signatures, data.parameterNames, data.nonNullLiteralArguments, data.parameterBindings);
    this.commonTypes = Object.freeze({ ...data.commonTypes });
    this.expressionTypes = Object.freeze({ ...data.expressionTypes });
    this.explicitInvocationArity = Object.freeze({ ...data.explicitInvocationArity });
    this.tableConstantNullTyping = data.tableConstantNullTyping;
    this.namedArgumentBinding =
      data.namedArgumentBinding === undefined
        ? undefined
        : Object.freeze({
            ...data.namedArgumentBinding,
            overrides: Object.freeze({ ...data.namedArgumentBinding.overrides }),
          });
    this.keywordInvocationForms = Object.freeze([...data.keywordInvocationForms]);
    this.#casts = new Set(data.implicitCasts.map(([source, target]) => `${source}\0${target}`));
    Object.freeze(this);
  }
  builtinSignatures(name: string): readonly DuckDBBuiltinSignature[] {
    if (this.#index === undefined) {
      const values = new Map<string, DuckDBBuiltinSignature[]>();
      for (const signature of this.signatures) {
        const bucket = values.get(signature[0]) ?? [];
        bucket.push(signature);
        values.set(signature[0], bucket);
      }
      this.#index = new Map([...values].map(([name, bucket]) => [name, Object.freeze(bucket)]));
    }
    return this.#index.get(name) ?? [];
  }
  scalarImplicitCast(source: string, target: string): boolean {
    return source === target || this.#casts.has(`${source}\0${target}`);
  }
}
export function duckDBBuiltinFormalNames(signature: DuckDBBuiltinSignature): FormalNames {
  return formalNames.get(signature) ?? [];
}
export function duckDBBuiltinParameterBindings(
  signature: DuckDBBuiltinSignature,
): readonly (readonly DuckDBFormalParameter[])[] {
  return parameterBindings.get(signature) ?? [];
}
export function duckDBBuiltinNonNullLiteralArguments(signature: DuckDBBuiltinSignature): readonly number[] {
  return literalConstraints.get(signature) ?? noLiteralConstraints;
}
