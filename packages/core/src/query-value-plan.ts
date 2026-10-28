import { type JsonValueDescriptor, parseJsonShape, validateJsonValue } from "./json.js";
import type { Query } from "./query.js";
import { queryResultValidationSource } from "./result-validation.js";

/** Logical JavaScript values selected by a grammar's type policy. */
export type RuntimeValueType =
  | "unknown"
  | "string"
  | "number"
  | "bigint"
  | "boolean"
  | "date"
  | "bytes"
  | { readonly array: RuntimeValueType }
  | { readonly union: readonly RuntimeValueType[] };

export interface QueryValueDescriptor {
  readonly type: RuntimeValueType;
  readonly nullable: boolean;
  readonly json?: JsonValueDescriptor;
}

export interface QueryValuePlan {
  readonly dialect: string;
  readonly typePolicyHash: string;
  readonly columns: readonly (QueryValueDescriptor & { readonly name: string })[];
  readonly parameters: readonly (QueryValueDescriptor & { readonly index: number })[];
}

/** Transport facts are independent of the grammar's desired JavaScript representation. */
export interface QueryTransportProfile {
  readonly id: string;
  readonly dialect: string;
  readonly typePolicyHash?: string;
  readonly integer: "safe-number" | "lossless";
  readonly jsonWire: "text" | "parsed";
  readonly normalizeValue?: (value: unknown, type: RuntimeValueType) => unknown;
}

export class QueryValueError extends TypeError {
  readonly code = "TSQL_QUERY_VALUE";
  constructor(
    readonly location: string,
    message: string,
  ) {
    super(`Query value at ${location}: ${message}`);
    this.name = "QueryValueError";
  }
}

const plans = new WeakMap<object, QueryValuePlan>();

function copyType(type: RuntimeValueType, depth = 0): RuntimeValueType {
  if (depth > 32) throw new TypeError("Runtime value type exceeds depth limit");
  if (typeof type === "string" && ["unknown", "string", "number", "bigint", "boolean", "date", "bytes"].includes(type))
    return type;
  if (typeof type === "object" && type !== null && "array" in type)
    return Object.freeze({ array: copyType(type.array, depth + 1) });
  if (typeof type === "object" && type !== null && "union" in type && type.union.length > 0 && type.union.length <= 32)
    return Object.freeze({ union: Object.freeze(type.union.map((member) => copyType(member, depth + 1))) });
  throw new TypeError("Invalid runtime value type");
}

function copyDescriptor(value: QueryValueDescriptor): QueryValueDescriptor {
  if (typeof value.nullable !== "boolean") throw new TypeError("Invalid runtime nullability");
  const json = value.json;
  if (json !== undefined && !["parsed", "text", "binary"].includes(json.representation))
    throw new TypeError("Invalid JSON representation");
  return Object.freeze({
    type: copyType(value.type),
    nullable: value.nullable,
    ...(json === undefined
      ? {}
      : { json: Object.freeze({ shape: parseJsonShape(json.shape), representation: json.representation }) }),
  });
}

const preparedPlans = new WeakSet<QueryValuePlan>();

/** Normalize static build metadata once; the returned plan is safe to reuse across calls. */
export function defineQueryValuePlan(plan: QueryValuePlan): QueryValuePlan {
  if (preparedPlans.has(plan)) return plan;
  if (
    typeof plan.dialect !== "string" ||
    !plan.dialect ||
    typeof plan.typePolicyHash !== "string" ||
    !plan.typePolicyHash
  )
    throw new TypeError("Invalid query value plan identity");
  const names = new Set<string>();
  const columns = plan.columns.map((column) => {
    if (typeof column.name !== "string" || names.has(column.name))
      throw new TypeError("Invalid or duplicate result column name");
    names.add(column.name);
    return Object.freeze({ ...copyDescriptor(column), name: column.name });
  });
  const parameters = plan.parameters.map((parameter, position) => {
    if (parameter.index !== position + 1) throw new TypeError("Query parameters must be ordered and contiguous");
    return Object.freeze({ ...copyDescriptor(parameter), index: parameter.index });
  });
  const result = Object.freeze({
    dialect: plan.dialect,
    typePolicyHash: plan.typePolicyHash,
    columns: Object.freeze(columns),
    parameters: Object.freeze(parameters),
  });
  preparedPlans.add(result);
  return result;
}

/** Attach compiler/grammar metadata without mutating the query or retaining parameter values. */
export function withQueryValuePlan<Row, Params extends readonly unknown[]>(
  query: Query<Row, Params>,
  plan: QueryValuePlan,
): Query<Row, Params> {
  const source = queryResultValidationSource(query);
  if (plans.has(source)) throw new TypeError("Query already has a value plan");
  plans.set(source, defineQueryValuePlan(plan));
  return query;
}

export function getQueryValuePlan<Row, Params extends readonly unknown[]>(
  query: Query<Row, Params>,
): QueryValuePlan | undefined {
  return plans.get(queryResultValidationSource(query));
}

function hasBigint(type: RuntimeValueType): boolean {
  return typeof type === "object"
    ? "array" in type
      ? hasBigint(type.array)
      : type.union.some(hasBigint)
    : type === "bigint";
}

export function assertQueryResultTransport<Row, Params extends readonly unknown[]>(
  query: Query<Row, Params>,
  profile: QueryTransportProfile,
): void {
  const plan = getQueryValuePlan(query);
  if (plan === undefined) throw new QueryValueError("plan", "runtime metadata is required");
  if (
    plan.dialect !== profile.dialect ||
    (profile.typePolicyHash !== undefined && plan.typePolicyHash !== profile.typePolicyHash)
  )
    throw new QueryValueError("plan", "transport and query policies differ");
  if (
    profile.integer === "safe-number" &&
    [...plan.columns, ...plan.parameters].some((item) => !item.json && hasBigint(item.type))
  )
    throw new QueryValueError("plan", "transport cannot preserve bigint values");
  if (
    profile.jsonWire === "parsed" &&
    plan.columns.some(
      (column) =>
        column.nullable && column.json?.representation === "text" && validateJsonValue(null, column.json.shape),
    )
  )
    throw new QueryValueError("plan", "parsed transport cannot distinguish SQL NULL from JSON null for text output");
}

function scalar(value: unknown, type: RuntimeValueType, location: string): unknown {
  if (typeof type === "object") {
    if ("union" in type) {
      for (const member of type.union) {
        try {
          return scalar(value, member, location);
        } catch (error) {
          if (!(error instanceof QueryValueError)) throw error;
        }
      }
      throw new QueryValueError(location, "value does not match any union member");
    }
    if (!Array.isArray(value)) throw new QueryValueError(location, "expected array");
    return value.map((item, index) => (item === null ? null : scalar(item, type.array, `${location}[${index}]`)));
  }
  const valid =
    type === "unknown" ||
    (type === "date"
      ? value instanceof Date && Number.isFinite(value.getTime())
      : type === "bytes"
        ? value instanceof Uint8Array
        : typeof value === type);
  if (
    !valid ||
    (typeof value === "number" &&
      (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))))
  )
    throw new QueryValueError(location, `expected ${type}`);
  return value;
}

function decode(
  value: unknown,
  descriptor: QueryValueDescriptor,
  profile: QueryTransportProfile,
  location: string,
): unknown {
  if (value === null) {
    if (
      descriptor.json?.representation === "text" &&
      profile.jsonWire === "parsed" &&
      !descriptor.nullable &&
      validateJsonValue(null, descriptor.json.shape)
    )
      return "null";
    if (
      descriptor.json?.representation === "parsed" &&
      profile.jsonWire === "parsed" &&
      validateJsonValue(null, descriptor.json.shape)
    )
      return null;
    if (!descriptor.nullable) throw new QueryValueError(location, "unexpected SQL NULL");
    return null;
  }
  const json = descriptor.json;
  if (json !== undefined) {
    if (json.representation === "binary") return scalar(value, "bytes", location);
    let parsed = value;
    if (profile.jsonWire === "text") {
      if (typeof value !== "string") throw new QueryValueError(location, "expected JSON text");
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new QueryValueError(location, "invalid JSON text");
      }
    }
    if (!validateJsonValue(parsed, json.shape))
      throw new QueryValueError(location, "JSON does not match its declared shape");
    return json.representation === "text" ? (profile.jsonWire === "text" ? value : JSON.stringify(parsed)) : parsed;
  }
  const normalized = profile.normalizeValue === undefined ? value : profile.normalizeValue(value, descriptor.type);
  return scalar(normalized, descriptor.type, location);
}

export function decodeQueryResultRows<Row, Params extends readonly unknown[]>(
  query: Query<Row, Params>,
  rows: readonly unknown[],
  profile: QueryTransportProfile,
): readonly Row[] {
  assertQueryResultTransport(query, profile);
  const plan = getQueryValuePlan(query)!;
  return rows.map((row, rowIndex) => {
    if (typeof row !== "object" || row === null || Array.isArray(row))
      throw new QueryValueError(`row ${rowIndex}`, "expected a result object");
    const result: Record<string, unknown> = {};
    for (const column of plan.columns) {
      if (!Object.hasOwn(row, column.name)) throw new QueryValueError(column.name, "missing result column");
      const value = decode((row as Record<string, unknown>)[column.name], column, profile, column.name);
      if (column.name === "__proto__")
        Object.defineProperty(result, column.name, { value, enumerable: true, writable: true, configurable: true });
      else result[column.name] = value;
    }
    return result as Row;
  });
}

export function encodeQueryValues<Row, Params extends readonly unknown[]>(
  query: Query<Row, Params>,
  values: readonly unknown[],
  profile: QueryTransportProfile,
): readonly unknown[] {
  assertQueryResultTransport(query, profile);
  const plan = getQueryValuePlan(query)!;
  if (values.length !== plan.parameters.length)
    throw new QueryValueError("parameters", "parameter count differs from plan");
  return values.map((value, index) => {
    const descriptor = plan.parameters[index]!;
    const location = `parameter ${index + 1}`;
    if (value === null) {
      if (!descriptor.nullable) throw new QueryValueError(location, "unexpected SQL NULL");
      return null;
    }
    if (descriptor.json === undefined) {
      if (profile.integer === "safe-number" && typeof value === "bigint")
        throw new QueryValueError(location, "transport cannot preserve bigint values");
      return scalar(value, descriptor.type, location);
    }
    const json = descriptor.json;
    if (json.representation === "binary") return scalar(value, "bytes", location);
    let parsed = value;
    if (json.representation === "text") {
      if (typeof value !== "string") throw new QueryValueError(location, "expected JSON text");
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new QueryValueError(location, "invalid JSON text");
      }
    }
    if (!validateJsonValue(parsed, json.shape))
      throw new QueryValueError(location, "JSON does not match its declared shape");
    return profile.jsonWire === "text" ? JSON.stringify(parsed) : parsed;
  });
}
