import {
  defineQueryValuePlan,
  type QueryValueDescriptor,
  type QueryValuePlan,
  type RuntimeValueType,
} from "@typed-sql/core";
import { canonicalContractData } from "./canonical.js";
import type { QueryContractContext } from "./contracts.js";

/** Unknown evidence is distinct from a known nullable value or incomplete native identity. */
export type NativeContractFact<Value> =
  | { readonly status: "known"; readonly value: Value }
  | { readonly status: "unknown"; readonly reason: string };
export interface NativeContractValueEvidence {
  readonly nativeType: NativeContractFact<{ readonly name: string; readonly complete: boolean }>;
  readonly runtimeType: NativeContractFact<RuntimeValueType>;
  readonly nullable: NativeContractFact<boolean>;
  /** Sanitized protocol/catalog data, supplied by the grammar owner, never a SQL invocation. */
  readonly descriptor: Readonly<Record<string, unknown>>;
}
export interface NativeQueryContractEvidence {
  readonly adapter: { readonly id: string; readonly version: string };
  readonly consistency: { readonly mechanism: "snapshot" | "guarded"; readonly scope: string };
  readonly resultKind: "rows" | "command";
  readonly columns: readonly (NativeContractValueEvidence & { readonly name: string })[];
  readonly parameters: readonly (NativeContractValueEvidence & { readonly index: number })[];
  /** Every placeholder occurrence, including repeats; offsets refer to the exact rendered SQL. */
  readonly parameterOccurrences: readonly { readonly index: number; readonly start: number; readonly end: number }[];
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid native contract evidence object");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(value).length !== names.length || names.some((name) => !Object.hasOwn(value, name)))
    throw new TypeError("Invalid native contract evidence fields");
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > 16_384)
    throw new TypeError("Invalid native contract evidence text");
}
function fact(value: unknown, check: (input: unknown) => void): void {
  const item = record(value);
  if (item.status === "known") {
    fields(item, ["status", "value"]);
    check(item.value);
  } else if (item.status === "unknown") {
    fields(item, ["status", "reason"]);
    text(item.reason);
  } else throw new TypeError("Invalid native contract evidence status");
}
function freeze<Value>(value: Value): Value {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Validates evidence independently of claims made by the static analyzer. */
export function parseNativeQueryContractEvidence(input: unknown, sqlLength: number): NativeQueryContractEvidence {
  if (!Number.isSafeInteger(sqlLength) || sqlLength < 1 || sqlLength > 8 * 1024 * 1024)
    throw new TypeError("Invalid native contract SQL length");
  const value = record(JSON.parse(canonicalContractData(input)));
  fields(value, ["adapter", "consistency", "resultKind", "columns", "parameters", "parameterOccurrences"]);
  const adapter = record(value.adapter),
    consistency = record(value.consistency);
  fields(adapter, ["id", "version"]);
  text(adapter.id);
  text(adapter.version);
  fields(consistency, ["mechanism", "scope"]);
  text(consistency.scope);
  if (
    !["snapshot", "guarded"].includes(consistency.mechanism as string) ||
    !["rows", "command"].includes(value.resultKind as string)
  )
    throw new TypeError("Invalid native contract evidence capability");
  for (const kind of ["columns", "parameters"] as const) {
    const items = value[kind];
    if (!Array.isArray(items)) throw new TypeError("Invalid native contract evidence descriptors");
    for (const [position, input] of items.entries()) {
      const item = record(input);
      fields(item, ["nativeType", "runtimeType", "nullable", "descriptor", kind === "columns" ? "name" : "index"]);
      if (kind === "columns") text(item.name);
      else if (item.index !== position + 1) throw new TypeError("Native parameters must be ordered contiguous slots");
      record(item.descriptor);
      fact(item.nativeType, (input) => {
        const identity = record(input);
        fields(identity, ["name", "complete"]);
        text(identity.name);
        if (typeof identity.complete !== "boolean") throw new TypeError("Invalid native identity completeness");
      });
      fact(item.runtimeType, (type) => {
        const plan = defineQueryValuePlan({
          dialect: "evidence",
          typePolicyHash: "evidence",
          columns: [{ name: "value", type: type as RuntimeValueType, nullable: true }],
          parameters: [],
        });
        if (canonicalContractData(plan.columns[0]!.type) !== canonicalContractData(type))
          throw new TypeError("Noncanonical native runtime type");
      });
      fact(item.nullable, (nullable) => {
        if (typeof nullable !== "boolean") throw new TypeError("Invalid native nullability");
      });
    }
  }
  validateNativeParameterOccurrences(value.parameterOccurrences, sqlLength, (value.parameters as unknown[]).length);
  const evidence = value as unknown as NativeQueryContractEvidence;
  if (evidence.resultKind === "command" && evidence.columns.length)
    throw new TypeError("Native command cannot have row columns");
  // Also validates duplicate labels and descriptor limits, without inventing known facets.
  nativeContractValuePlan(evidence, {
    grammar: { id: "evidence", version: "evidence" },
    typePolicyHash: "evidence",
  });
  return freeze(evidence);
}
function descriptor(value: NativeContractValueEvidence): QueryValueDescriptor {
  return {
    ...(value.nativeType.status === "known" ? { databaseType: value.nativeType.value.name } : {}),
    type: value.runtimeType.status === "known" ? value.runtimeType.value : "unknown",
    nullable: value.nullable.status === "known" ? value.nullable.value : true,
  };
}
export function nativeContractValuePlan(
  evidence: NativeQueryContractEvidence,
  context: Pick<QueryContractContext, "grammar" | "typePolicyHash">,
): QueryValuePlan {
  return defineQueryValuePlan({
    dialect: context.grammar.id,
    typePolicyHash: context.typePolicyHash,
    columns: evidence.columns.map((column) => ({ ...descriptor(column), name: column.name })),
    parameters: evidence.parameters.map((parameter) => ({ ...descriptor(parameter), index: parameter.index })),
  });
}

export function validateNativeParameterOccurrences(input: unknown, sqlLength: number, count?: number): void {
  if (!Array.isArray(input)) throw new TypeError("Invalid native parameter occurrences");
  const parameterCount = count ?? new Set(input.map((item) => record(item).index)).size;
  const seen = new Set<number>();
  let end = 0;
  for (const item of input) {
    const occurrence = record(item);
    fields(occurrence, ["index", "start", "end"]);
    if (
      !Number.isSafeInteger(occurrence.index) ||
      (occurrence.index as number) < 1 ||
      (occurrence.index as number) > parameterCount ||
      !Number.isSafeInteger(occurrence.start) ||
      !Number.isSafeInteger(occurrence.end) ||
      (occurrence.start as number) < end ||
      (occurrence.end as number) <= (occurrence.start as number) ||
      (occurrence.end as number) > sqlLength
    )
      throw new TypeError("Invalid native parameter occurrence layout");
    seen.add(occurrence.index as number);
    end = occurrence.end as number;
  }
  if (seen.size !== parameterCount) throw new TypeError("Native parameter slot has no occurrence");
}

/** A generic/opaque bind type cannot establish which native overload is being described. */
export function nativeContractParametersAvailable(evidence: NativeQueryContractEvidence): boolean {
  return evidence.parameters.every(
    (parameter) =>
      parameter.nativeType.status === "known" &&
      parameter.runtimeType.status === "known" &&
      parameter.runtimeType.value !== "unknown" &&
      parameter.runtimeType.value !== "never",
  );
}
