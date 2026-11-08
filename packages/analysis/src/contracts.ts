import { defineQueryValuePlan, type QueryValuePlan } from "@typed-sql/core";
import { canonicalContractData, exactSqlDigest, queryContractDigest } from "./canonical.js";
import {
  type NativeQueryContractEvidence,
  nativeContractValuePlan,
  parseNativeQueryContractEvidence,
} from "./native-evidence.js";

import { parseQueryContractQualification, type QueryContractQualification } from "./qualification-model.js";

export interface QueryContractContext {
  readonly grammar: { readonly id: string; readonly version: string };
  readonly profileHash: string;
  readonly schemaHash: string;
  readonly databaseContextHash: string;
  readonly typePolicyHash: string;
  readonly codecHash: string;
  readonly interpreterHash: string;
}
export interface QueryContract {
  readonly formatVersion: 1;
  readonly digest: string;
  readonly context: QueryContractContext;
  readonly sqlDigest: string;
  readonly sqlLength: number;
  readonly origin: "offline-rule" | "native-description" | "reconciled";
  readonly valuePlan: QueryValuePlan;
  readonly nativeEvidence?: NativeQueryContractEvidence;
  readonly qualification?: QueryContractQualification;
  /** SQL-relative ranges; source-file positions are never persisted. */
  readonly columnSpans: readonly { readonly start: number; readonly end: number }[];
}
const hash = /^[a-f0-9]{64}$/u;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected query contract object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !Object.hasOwn(value, key)))
    throw new TypeError("Unexpected or missing query contract fields");
}
function freeze<Value>(value: Value): Value {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function parseQueryContractContext(input: unknown): QueryContractContext {
  const value = object(JSON.parse(canonicalContractData(input)));
  const hashes = ["profileHash", "schemaHash", "databaseContextHash", "typePolicyHash", "codecHash", "interpreterHash"];
  keys(value, ["grammar", ...hashes]);
  const grammar = object(value.grammar);
  keys(grammar, ["id", "version"]);
  for (const key of ["id", "version"])
    if (typeof grammar[key] !== "string" || !(grammar[key] as string).length || (grammar[key] as string).length > 256)
      throw new TypeError("Invalid contract grammar identity");
  for (const key of hashes)
    if (typeof value[key] !== "string" || !hash.test(value[key] as string))
      throw new TypeError(`Invalid query contract ${key}`);
  return freeze(value) as unknown as QueryContractContext;
}
export function parseQueryContract(input: unknown): QueryContract {
  const value = object(JSON.parse(canonicalContractData(input)));
  keys(value, [
    "formatVersion",
    "digest",
    "context",
    "sqlDigest",
    "sqlLength",
    "origin",
    "valuePlan",
    "columnSpans",
    ...(Object.hasOwn(value, "nativeEvidence") ? ["nativeEvidence"] : []),
    ...(Object.hasOwn(value, "qualification") ? ["qualification"] : []),
  ]);
  if (
    value.formatVersion !== 1 ||
    typeof value.digest !== "string" ||
    !hash.test(value.digest) ||
    typeof value.sqlDigest !== "string" ||
    !hash.test(value.sqlDigest)
  )
    throw new TypeError("Invalid query contract format or digest");
  if (
    !Number.isSafeInteger(value.sqlLength) ||
    (value.sqlLength as number) < 1 ||
    (value.sqlLength as number) > 8 * 1024 * 1024
  )
    throw new TypeError("Invalid query contract SQL length");
  if (!["offline-rule", "native-description", "reconciled"].includes(value.origin as string))
    throw new TypeError("Invalid query contract origin");
  const context = parseQueryContractContext(value.context);
  const plan = defineQueryValuePlan(object(value.valuePlan) as unknown as QueryValuePlan);
  if (plan.dialect !== context.grammar.id || plan.typePolicyHash !== context.typePolicyHash)
    throw new TypeError("Query contract codec policy mismatch");
  if (!Array.isArray(value.columnSpans) || value.columnSpans.length !== plan.columns.length)
    throw new TypeError("Query contract result span count differs");
  for (const item of value.columnSpans) {
    const span = object(item);
    keys(span, ["start", "end"]);
    if (
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      (span.start as number) < 0 ||
      (span.end as number) < (span.start as number) ||
      (span.end as number) > (value.sqlLength as number)
    )
      throw new TypeError("Invalid query contract SQL span");
  }
  if (Object.hasOwn(value, "nativeEvidence")) {
    const evidence = parseNativeQueryContractEvidence(value.nativeEvidence, value.sqlLength as number);
    if (
      value.origin === "offline-rule" ||
      canonicalContractData(nativeContractValuePlan(evidence, context)) !== canonicalContractData(plan)
    )
      throw new TypeError("Native contract evidence differs from its value plan or origin");
  }
  if (Object.hasOwn(value, "qualification")) {
    if (!value.nativeEvidence || value.origin !== "reconciled")
      throw new TypeError("Qualification requires reconciled native evidence");
    const qualification = parseQueryContractQualification(
      value.qualification,
      value.nativeEvidence as NativeQueryContractEvidence,
    );
    const { digest: _digest, qualification: _qualification, ...nativeBody } = value;
    if (queryContractDigest({ ...nativeBody, origin: "native-description" }) !== qualification.sourceContractHash)
      throw new TypeError("Qualification native source contract differs");
  }
  const { digest, ...body } = value;
  if (queryContractDigest(body) !== digest) throw new TypeError("Query contract content digest differs");
  // Normalize only after checking the original bytes: unknown plan fields cannot become trusted metadata.
  if (canonicalContractData(plan) !== canonicalContractData(value.valuePlan))
    throw new TypeError("Noncanonical query contract value plan");
  return freeze({ ...body, context, valuePlan: plan, digest }) as unknown as QueryContract;
}
export function createQueryContract(input: {
  readonly sql: string;
  readonly context: QueryContractContext;
  readonly origin: QueryContract["origin"];
  readonly valuePlan: QueryValuePlan;
  readonly columnSpans?: QueryContract["columnSpans"];
  readonly nativeEvidence?: NativeQueryContractEvidence;
  readonly qualification?: QueryContractQualification;
}): QueryContract {
  const context = parseQueryContractContext(input.context),
    plan = defineQueryValuePlan(input.valuePlan);
  const body = {
    formatVersion: 1,
    context,
    sqlDigest: exactSqlDigest(input.sql),
    sqlLength: input.sql.length,
    origin: input.origin,
    valuePlan: plan,
    ...(input.nativeEvidence === undefined ? {} : { nativeEvidence: input.nativeEvidence }),
    ...(input.qualification === undefined ? {} : { qualification: input.qualification }),
    columnSpans: input.columnSpans ?? plan.columns.map(() => ({ start: 0, end: input.sql.length })),
  };
  return parseQueryContract({ ...body, digest: queryContractDigest(body) });
}
export function serializeQueryContract(contract: QueryContract): string {
  return `${canonicalContractData(parseQueryContract(contract))}\n`;
}
export function createQueryContractIndex(inputs: readonly QueryContract[]) {
  const records = new Map<string, QueryContract>();
  for (const input of inputs) {
    const contract = parseQueryContract(input),
      key = queryContractDigest({ context: contract.context, sqlDigest: contract.sqlDigest });
    const previous = records.get(key);
    if (previous && previous.digest !== contract.digest)
      throw new TypeError("Conflicting query contracts for identical inputs");
    records.set(key, contract);
  }
  return Object.freeze({
    resolve(context: QueryContractContext, sql: string): QueryContract | undefined {
      return records.get(
        queryContractDigest({ context: parseQueryContractContext(context), sqlDigest: exactSqlDigest(sql) }),
      );
    },
    get size() {
      return records.size;
    },
  });
}
