import type { QueryStream } from "./execution.js";
import {
  type JsonShape,
  type JsonValueDescriptor,
  parseJsonShape,
  validateJsonValue,
  validateParsedJsonTextShape,
} from "./json.js";
import { serializedJsonInput } from "./json-input.js";
import { explicitJsonParameterIndexes, type Query } from "./query.js";
import type { QueryValuePlanSelector } from "./query-value-plan-selection.js";
import { mapQueryResultStream, queryResultValidationSource } from "./result-validation.js";

/** Logical JavaScript values selected by a grammar's type policy. */
export type RuntimeValueType =
  | "unknown"
  | "string"
  | "number"
  | "bigint"
  | "boolean"
  | "date"
  | "bytes"
  | { readonly json: JsonValueDescriptor }
  | { readonly literal: string | number | boolean }
  | { readonly array: RuntimeValueType; readonly elementNullable?: boolean }
  | { readonly union: readonly RuntimeValueType[] };

export interface QueryValueDescriptor {
  /** Parameter-only permission for explicit JSON text without excluding native document inputs. */
  readonly acceptsJsonInput?: true;
  readonly scalarJsonShape?: JsonShape;
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
  /** SQL JSON parameters use serialized documents, independently of result parsing. */
  readonly jsonInputWire?: "text";
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
const requiredPlans = new WeakSet<object>();
const normalizedShapeNodes = new WeakMap<JsonShape, number>();

interface PlanBudget {
  remaining: number;
}

function copyType(
  type: RuntimeValueType,
  budget: PlanBudget,
  depth = 0,
  local: PlanBudget = { remaining: 1024 },
): RuntimeValueType {
  if (--budget.remaining < 0 || --local.remaining < 0) throw new TypeError("Runtime value plan expansion limit");
  if (depth > 32) throw new TypeError("Runtime value type exceeds depth limit");
  if (typeof type === "string" && ["unknown", "string", "number", "bigint", "boolean", "date", "bytes"].includes(type))
    return type;
  if (typeof type === "object" && type !== null && "json" in type)
    return Object.freeze({ json: copyDescriptor({ type: "unknown", nullable: false, json: type.json }, budget).json! });
  if (
    typeof type === "object" &&
    type !== null &&
    "literal" in type &&
    ["string", "number", "boolean"].includes(typeof type.literal) &&
    (typeof type.literal !== "number" || Number.isFinite(type.literal))
  )
    return Object.freeze({ literal: type.literal });
  if (typeof type === "object" && type !== null && "array" in type) {
    if (type.elementNullable !== undefined && typeof type.elementNullable !== "boolean")
      throw new TypeError("Invalid array element nullability");
    return Object.freeze({
      array: copyType(type.array, budget, depth + 1, local),
      ...(type.elementNullable === undefined ? {} : { elementNullable: type.elementNullable }),
    });
  }
  if (typeof type === "object" && type !== null && "union" in type && type.union.length > 0 && type.union.length <= 32)
    return Object.freeze({
      union: Object.freeze(type.union.map((member) => copyType(member, budget, depth + 1, local))),
    });
  throw new TypeError("Invalid runtime value type");
}

function copyShape(shape: JsonShape, budget: PlanBudget): JsonShape {
  const ownedNodes = normalizedShapeNodes.get(shape);
  if (ownedNodes !== undefined) {
    budget.remaining -= ownedNodes;
    if (budget.remaining < 0) throw new TypeError("Runtime value plan expansion limit");
    return shape;
  }
  const normalized = parseJsonShape(shape);
  const remaining = budget.remaining;
  const visit = (item: JsonShape): void => {
    if (--budget.remaining < 0) throw new TypeError("Runtime value plan expansion limit");
    switch (item.kind) {
      case "array":
        visit(item.element);
        break;
      case "tuple":
        item.elements.forEach(visit);
        break;
      case "union":
        item.variants.forEach(visit);
        break;
      case "object":
        for (const property of Object.values(item.properties)) visit(property.shape);
        if (item.additionalProperties !== undefined) visit(item.additionalProperties);
    }
  };
  visit(normalized);
  normalizedShapeNodes.set(normalized, remaining - budget.remaining);
  return normalized;
}

function copyDescriptor(value: QueryValueDescriptor, budget: PlanBudget): QueryValueDescriptor {
  if (typeof value.nullable !== "boolean") throw new TypeError("Invalid runtime nullability");
  const json = value.json;
  if (json !== undefined && value.scalarJsonShape !== undefined)
    throw new TypeError("A value cannot be both serialized JSON and a native JSON scalar");
  if (json !== undefined && !["parsed", "text", "binary"].includes(json.representation))
    throw new TypeError("Invalid JSON representation");
  return Object.freeze({
    type: copyType(value.type, budget),
    nullable: value.nullable,
    ...(value.acceptsJsonInput === true ? { acceptsJsonInput: true as const } : {}),
    ...(value.scalarJsonShape === undefined ? {} : { scalarJsonShape: copyShape(value.scalarJsonShape, budget) }),
    ...(json === undefined
      ? {}
      : {
          json: Object.freeze({
            shape: copyShape(json.shape, budget),
            representation: json.representation,
            ...(json.requiresRuntimeValidation === true ? { requiresRuntimeValidation: true as const } : {}),
          }),
        }),
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
  if (
    !Array.isArray(plan.columns) ||
    !Array.isArray(plan.parameters) ||
    plan.columns.length > 65_535 ||
    plan.parameters.length > 65_535
  )
    throw new TypeError("Runtime value plan descriptor count limit");
  const budget: PlanBudget = { remaining: 262_144 };
  const names = new Set<string>();
  const columns = plan.columns.map((column) => {
    if (typeof column.name !== "string" || names.has(column.name))
      throw new TypeError("Invalid or duplicate result column name");
    names.add(column.name);
    return Object.freeze({ ...copyDescriptor(column, budget), name: column.name });
  });
  const parameters = plan.parameters.map((parameter, position) => {
    if (parameter.index !== position + 1) throw new TypeError("Query parameters must be ordered and contiguous");
    return Object.freeze({ ...copyDescriptor(parameter, budget), index: parameter.index });
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
  plan: QueryValuePlan | QueryValuePlanSelector,
): Query<Row, Params> {
  const source = queryResultValidationSource(query);
  const existing = plans.get(source);
  if (existing !== undefined && typeof plan !== "function") throw new TypeError("Query already has a value plan");
  const selected = defineQueryValuePlan(typeof plan === "function" ? plan(query) : plan);
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(selected))
      throw new TypeError("Query already has a different value plan");
    return query;
  }
  plans.set(source, selected);
  return query;
}

/** @internal Changed SQL must receive a newly verified plan before it can execute. */
export function inheritQueryValuePlanRequirement<
  SourceRow,
  SourceParams extends readonly unknown[],
  Row,
  Params extends readonly unknown[],
>(sourceQuery: Query<SourceRow, SourceParams>, query: Query<Row, Params>): void {
  const source = queryResultValidationSource(sourceQuery);
  if (plans.has(source) || requiredPlans.has(source)) requiredPlans.add(queryResultValidationSource(query));
}

export function getQueryValuePlan<Row, Params extends readonly unknown[]>(
  query: Query<Row, Params>,
): QueryValuePlan | undefined {
  const source = queryResultValidationSource(query);
  const plan = plans.get(source);
  if (plan === undefined && requiredPlans.has(source))
    throw new QueryValueError("plan", "Composed SQL requires a newly verified runtime value plan");
  return plan;
}

function hasBigint(type: RuntimeValueType): boolean {
  return typeof type === "object"
    ? "json" in type
      ? false
      : "literal" in type
        ? false
        : "array" in type
          ? hasBigint(type.array)
          : type.union.some(hasBigint)
    : type === "bigint";
}

function ambiguousParsedJson(type: RuntimeValueType, nullable: boolean, json?: JsonValueDescriptor): boolean {
  if (json !== undefined)
    return (
      nullable &&
      ((json.representation === "text" && validateJsonValue(null, json.shape)) ||
        (json.requiresRuntimeValidation === true && !validateJsonValue(null, json.shape)))
    );
  if (typeof type === "string" || "literal" in type) return false;
  if ("json" in type) return ambiguousParsedJson("unknown", nullable, type.json);
  if ("array" in type) return ambiguousParsedJson(type.array, type.elementNullable !== false);
  return type.union.some((member) => ambiguousParsedJson(member, nullable));
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
    plan.columns.some((column) => ambiguousParsedJson(column.type, column.nullable, column.json))
  )
    throw new QueryValueError("plan", "parsed transport cannot distinguish SQL NULL from JSON null for this contract");
}

function scalar(
  value: unknown,
  type: RuntimeValueType,
  location: string,
  profile?: QueryTransportProfile,
  encoding = false,
): unknown {
  if (typeof type === "object") {
    if ("json" in type) {
      if (profile === undefined) throw new QueryValueError(location, "missing JSON transport profile");
      const descriptor = { type: "unknown" as const, nullable: false, json: type.json };
      return encoding
        ? encodeValue(value, descriptor, profile, location, false)
        : decode(value, descriptor, profile, location);
    }
    if ("literal" in type) {
      if (value !== type.literal) throw new QueryValueError(location, "value does not match its literal type");
      return value;
    }
    if ("union" in type) {
      for (const member of type.union) {
        try {
          return scalar(value, member, location, profile, encoding);
        } catch (error) {
          if (!(error instanceof QueryValueError)) throw error;
        }
      }
      throw new QueryValueError(location, "value does not match any union member");
    }
    if (!Array.isArray(value)) throw new QueryValueError(location, "expected array");
    return value.map((item, index) => {
      if (item === null) {
        if (type.elementNullable === false) {
          if (!encoding && typeof type.array === "object" && "json" in type.array && profile?.jsonWire === "parsed")
            return scalar(item, type.array, `${location}[${index}]`, profile, false);
          throw new QueryValueError(`${location}[${index}]`, "unexpected NULL array element");
        }
        return null;
      }
      return scalar(item, type.array, `${location}[${index}]`, profile, encoding);
    });
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

/** SQLite can expose an integer extracted from JSON as bigint under its integer policy. */
function matchesNativeJsonScalar(value: unknown, shape: JsonShape): boolean {
  if (typeof value !== "bigint") return validateJsonValue(value, shape);
  switch (shape.kind) {
    case "unknown":
    case "number":
      return true;
    case "literal":
      return typeof shape.value === "number" && Number.isSafeInteger(shape.value) && value === BigInt(shape.value);
    case "union":
      return shape.variants.some((member) => matchesNativeJsonScalar(value, member));
    default:
      return false;
  }
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
    const valid =
      json.representation === "text" && profile.jsonWire === "text"
        ? validateParsedJsonTextShape(parsed, json.shape)
        : validateJsonValue(parsed, json.shape);
    if (!valid) throw new QueryValueError(location, "JSON does not match its declared shape");
    return json.representation === "text" ? (profile.jsonWire === "text" ? value : JSON.stringify(parsed)) : parsed;
  }
  const normalized = profile.normalizeValue === undefined ? value : profile.normalizeValue(value, descriptor.type);
  const result = scalar(normalized, descriptor.type, location, profile);
  if (descriptor.scalarJsonShape !== undefined && !matchesNativeJsonScalar(result, descriptor.scalarJsonShape))
    throw new QueryValueError(location, "native JSON scalar does not match its declared shape");
  return result;
}

export function decodeQueryResultRows<Row, Params extends readonly unknown[]>(
  query: Query<Row, Params>,
  rows: readonly unknown[],
  profile: QueryTransportProfile,
): readonly Row[] {
  assertQueryResultTransport(query, profile);
  const plan = getQueryValuePlan(query)!;
  return rows.map((row, index) => decodeRow(row, plan, profile, index) as Row);
}

function decodeRow(
  row: unknown,
  plan: QueryValuePlan,
  profile: QueryTransportProfile,
  rowIndex: number,
): Record<string, unknown> {
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
  return result;
}

export function decodeQueryResultStream<Row, Params extends readonly unknown[]>(
  query: Query<Row, Params>,
  stream: QueryStream<unknown>,
  profile: QueryTransportProfile,
  onError?: (error: unknown) => void,
): QueryStream<Row> {
  assertQueryResultTransport(query, profile);
  const plan = getQueryValuePlan(query)!;
  return mapQueryResultStream(stream, (row, index) => {
    try {
      return decodeRow(row, plan, profile, index) as Row;
    } catch (error) {
      try {
        onError?.(error);
      } catch {
        /* Preserve the original value failure. */
      }
      throw error;
    }
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
  const explicitJson = explicitJsonParameterIndexes(query as unknown as Query<unknown, readonly unknown[]>);
  return values.map((value, index) =>
    encodeValue(value, plan.parameters[index]!, profile, `parameter ${index + 1}`, explicitJson.has(index)),
  );
}

function encodeValue(
  value: unknown,
  descriptor: QueryValueDescriptor,
  profile: QueryTransportProfile,
  location: string,
  explicitJson: boolean,
): unknown {
  const encoded = serializedJsonInput(value);
  if (encoded !== undefined) {
    value = encoded;
    explicitJson = true;
  }
  if (value === null) {
    if (!descriptor.nullable) throw new QueryValueError(location, "unexpected SQL NULL");
    return null;
  }
  if (descriptor.json === undefined) {
    if (explicitJson) {
      if (descriptor.acceptsJsonInput !== true)
        throw new QueryValueError(location, "explicit JSON binding requires a JSON parameter contract");
      return scalar(value, "string", location);
    }
    if (profile.integer === "safe-number" && typeof value === "bigint")
      throw new QueryValueError(location, "transport cannot preserve bigint values");
    const result = scalar(value, descriptor.type, location, profile, true);
    if (descriptor.scalarJsonShape !== undefined && !matchesNativeJsonScalar(result, descriptor.scalarJsonShape))
      throw new QueryValueError(location, "native JSON scalar does not match its declared shape");
    return result;
  }
  const json = descriptor.json;
  if (json.representation === "binary") return scalar(value, "bytes", location);
  let parsed = value;
  if (json.representation === "text" || explicitJson) {
    if (typeof value !== "string") throw new QueryValueError(location, "expected JSON text");
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new QueryValueError(location, "invalid JSON text");
    }
  }
  const textInput = json.representation === "text" || explicitJson;
  const valid = textInput ? validateParsedJsonTextShape(parsed, json.shape) : validateJsonValue(parsed, json.shape);
  if (!valid) throw new QueryValueError(location, "JSON does not match its declared shape");
  return json.representation === "text" || explicitJson ? value : JSON.stringify(parsed);
}
