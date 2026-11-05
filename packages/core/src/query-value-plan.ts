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

/** One required native object field or positional tuple slot. SQL NULL is independent of its type. */
export interface RuntimeValueField {
  readonly type: RuntimeValueType;
  readonly nullable: boolean;
}

/** Logical JavaScript values selected by a grammar's type policy. */
export type RuntimeValueType =
  | "never"
  | "unknown"
  | "string"
  | "number"
  | "bigint"
  | "boolean"
  | "date"
  | "bytes"
  | { readonly json: JsonValueDescriptor }
  | { readonly literal: string | number | boolean }
  | { readonly array: RuntimeValueType; readonly elementNullable?: boolean; readonly length?: number }
  | { readonly object: Readonly<Record<string, RuntimeValueField>> }
  | { readonly tuple: readonly RuntimeValueField[] }
  | { readonly union: readonly RuntimeValueType[] };

export interface QueryValueDescriptor {
  /** Opaque grammar-owned physical target. This text is metadata, never trusted executable SQL. */
  readonly databaseType?: string;
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
  text?: number;
}

/** Inspect own data without executing getters or accepting inherited schema evidence. */
function dataObject(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new TypeError("Runtime value metadata requires a plain object");
  if (Object.getOwnPropertySymbols(value).length)
    throw new TypeError("Runtime value metadata cannot contain symbol keys");
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))
    if (!("value" in descriptor) || !descriptor.enumerable)
      throw new TypeError("Runtime value metadata cannot contain accessors or hidden properties");
  return value as Record<string, unknown>;
}

function dataArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    throw new TypeError("Runtime value metadata requires an array");
  if (value.length > 262_144) throw new TypeError("Runtime value array expansion limit");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index++)
    if (!descriptors[index] || !("value" in descriptors[index]!))
      throw new TypeError("Runtime value metadata arrays require own data entries");
  if (Reflect.ownKeys(descriptors).length !== value.length + 1)
    throw new TypeError("Unexpected runtime value metadata array properties");
  return value;
}

function allowedKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError("Invalid runtime value type");
}

function chargeText(value: string, budget: PlanBudget, maximum: number): string {
  if (value.length > maximum || value.includes("\0")) throw new TypeError("Runtime value metadata text limit");
  budget.text = (budget.text ?? 1_048_576) - value.length;
  if (budget.text < 0) throw new TypeError("Runtime value metadata text limit");
  return value;
}

function inspectShape(value: unknown, budget = { remaining: 8192 }, depth = 0): void {
  if (--budget.remaining < 0 || depth > 128) throw new TypeError("Runtime value shape expansion limit");
  if (typeof value !== "object" || value === null) return;
  const values = Array.isArray(value) ? dataArray(value) : Object.values(dataObject(value));
  for (const child of values) inspectShape(child, budget, depth + 1);
}

function copyType(
  type: RuntimeValueType,
  budget: PlanBudget,
  depth = 0,
  local: PlanBudget = { remaining: 1024 },
): RuntimeValueType {
  if (--budget.remaining < 0 || --local.remaining < 0) throw new TypeError("Runtime value plan expansion limit");
  if (depth > 32) throw new TypeError("Runtime value type exceeds depth limit");
  if (
    typeof type === "string" &&
    ["never", "unknown", "string", "number", "bigint", "boolean", "date", "bytes"].includes(type)
  )
    return type;
  const source = dataObject(type);
  if (Object.hasOwn(source, "json")) {
    allowedKeys(source, ["json"]);
    return Object.freeze({
      json: copyDescriptor({ type: "unknown", nullable: false, json: source.json as JsonValueDescriptor }, budget)
        .json!,
    });
  }
  if (Object.hasOwn(source, "literal")) {
    allowedKeys(source, ["literal"]);
    const literal = source.literal;
    if (
      !["string", "number", "boolean"].includes(typeof literal) ||
      (typeof literal === "number" && !Number.isFinite(literal))
    )
      throw new TypeError("Invalid runtime value type");
    if (typeof literal === "string") chargeText(literal, budget, 16_384);
    return Object.freeze({ literal: literal as string | number | boolean });
  }
  if (Object.hasOwn(source, "array")) {
    allowedKeys(source, ["array", "elementNullable", "length"]);
    if (source.elementNullable !== undefined && typeof source.elementNullable !== "boolean")
      throw new TypeError("Invalid array element nullability");
    if (
      source.length !== undefined &&
      (!Number.isSafeInteger(source.length) || (source.length as number) < 0 || (source.length as number) > 262_144)
    )
      throw new TypeError("Invalid runtime array length");
    return Object.freeze({
      array: copyType(source.array as RuntimeValueType, budget, depth + 1, local),
      ...(source.elementNullable === undefined ? {} : { elementNullable: source.elementNullable as boolean }),
      ...(source.length === undefined ? {} : { length: source.length as number }),
    });
  }
  const copyField = (value: unknown): RuntimeValueField => {
    if (--budget.remaining < 0 || --local.remaining < 0) throw new TypeError("Runtime value plan expansion limit");
    const field = dataObject(value);
    allowedKeys(field, ["type", "nullable"]);
    if (!Object.hasOwn(field, "type") || !Object.hasOwn(field, "nullable") || typeof field.nullable !== "boolean")
      throw new TypeError("Invalid runtime field nullability");
    return Object.freeze({
      type: copyType(field.type as RuntimeValueType, budget, depth + 1, local),
      nullable: field.nullable,
    });
  };
  if (Object.hasOwn(source, "object")) {
    allowedKeys(source, ["object"]);
    const fields = dataObject(source.object);
    return Object.freeze({
      object: Object.freeze(
        Object.fromEntries(
          Object.keys(fields)
            .sort()
            .map((key) => [chargeText(key, budget, 16_384), copyField(fields[key])]),
        ),
      ),
    });
  }
  if (Object.hasOwn(source, "tuple")) {
    allowedKeys(source, ["tuple"]);
    return Object.freeze({ tuple: Object.freeze(dataArray(source.tuple).map(copyField)) });
  }
  if (Object.hasOwn(source, "union")) {
    allowedKeys(source, ["union"]);
    const members = dataArray(source.union);
    if (members.length > 0 && members.length <= 32)
      return Object.freeze({
        union: Object.freeze(members.map((member) => copyType(member as RuntimeValueType, budget, depth + 1, local))),
      });
  }
  throw new TypeError("Invalid runtime value type");
}

function copyShape(shape: JsonShape, budget: PlanBudget): JsonShape {
  const ownedNodes = normalizedShapeNodes.get(shape);
  if (ownedNodes !== undefined) {
    budget.remaining -= ownedNodes;
    if (budget.remaining < 0) throw new TypeError("Runtime value plan expansion limit");
    return shape;
  }
  inspectShape(shape);
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
  dataObject(value);
  if (!Object.hasOwn(value, "type") || !Object.hasOwn(value, "nullable") || typeof value.nullable !== "boolean")
    throw new TypeError("Invalid runtime nullability");
  const json = value.json;
  if (json !== undefined) dataObject(json);
  if (value.databaseType !== undefined && (typeof value.databaseType !== "string" || !value.databaseType.length))
    throw new TypeError("Invalid runtime database type");
  if (json !== undefined && value.scalarJsonShape !== undefined)
    throw new TypeError("A value cannot be both serialized JSON and a native JSON scalar");
  if (json !== undefined && !["parsed", "text", "binary"].includes(json.representation))
    throw new TypeError("Invalid JSON representation");
  return Object.freeze({
    type: copyType(value.type, budget),
    nullable: value.nullable,
    ...(value.databaseType === undefined ? {} : { databaseType: chargeText(value.databaseType, budget, 4096) }),
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
  dataObject(plan);
  if (
    !["dialect", "typePolicyHash", "columns", "parameters"].every((key) => Object.hasOwn(plan, key)) ||
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
  dataArray(plan.columns);
  dataArray(plan.parameters);
  const budget: PlanBudget = { remaining: 262_144, text: 1_048_576 };
  const names = new Set<string>();
  const columns = plan.columns.map((column) => {
    dataObject(column);
    if (typeof column.name !== "string" || names.has(column.name))
      throw new TypeError("Invalid or duplicate result column name");
    chargeText(column.name, budget, 16_384);
    names.add(column.name);
    return Object.freeze({ ...copyDescriptor(column, budget), name: column.name });
  });
  const parameters = plan.parameters.map((parameter, position) => {
    dataObject(parameter);
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
  if (typeof type === "string") return type === "bigint";
  if ("json" in type || "literal" in type) return false;
  if ("array" in type) return hasBigint(type.array);
  if ("object" in type) return Object.values(type.object).some((field) => hasBigint(field.type));
  if ("tuple" in type) return type.tuple.some((field) => hasBigint(field.type));
  return type.union.some(hasBigint);
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
  if ("object" in type)
    return Object.values(type.object).some((field) => ambiguousParsedJson(field.type, field.nullable));
  if ("tuple" in type) return type.tuple.some((field) => ambiguousParsedJson(field.type, field.nullable));
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

interface ValueBudget {
  remaining: number;
}

function valueObject(value: unknown, location: string): Record<string, unknown> {
  try {
    return dataObject(value);
  } catch {
    throw new QueryValueError(location, "expected a plain object with own data properties");
  }
}

function valueArray(value: unknown, location: string): readonly unknown[] {
  try {
    return dataArray(value);
  } catch {
    throw new QueryValueError(location, "expected an array with own data entries within the expansion limit");
  }
}

function scalar(
  value: unknown,
  type: RuntimeValueType,
  location: string,
  profile?: QueryTransportProfile,
  encoding = false,
  budget: ValueBudget = { remaining: 262_144 },
  owned = false,
): unknown {
  if (--budget.remaining < 0) throw new QueryValueError(location, "native value expansion limit");
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
          return scalar(value, member, location, profile, encoding, budget, owned);
        } catch (error) {
          if (!(error instanceof QueryValueError)) throw error;
        }
      }
      throw new QueryValueError(location, "value does not match any union member");
    }
    const fieldValue = (item: unknown, field: RuntimeValueField, path: string): unknown => {
      if (item === null) {
        if (field.nullable) return null;
        if (!encoding && typeof field.type === "object" && "json" in field.type && profile?.jsonWire === "parsed")
          return scalar(item, field.type, path, profile, false, budget, true);
        throw new QueryValueError(path, "unexpected NULL field");
      }
      return scalar(item, field.type, path, profile, encoding, budget, true);
    };
    if ("object" in type) {
      const source = valueObject(value, location);
      const names = Object.keys(type.object);
      if (
        Object.getOwnPropertyNames(source).length !== names.length ||
        names.some((name) => !Object.hasOwn(source, name))
      )
        throw new QueryValueError(location, "object fields differ from the native contract");
      return Object.fromEntries(
        names.map((name) => [name, fieldValue(source[name], type.object[name]!, `${location}.${name}`)]),
      );
    }
    const items = valueArray(value, location);
    if ("tuple" in type) {
      if (items.length !== type.tuple.length)
        throw new QueryValueError(location, "tuple length differs from the native contract");
      return items.map((item, index) => fieldValue(item, type.tuple[index]!, `${location}[${index}]`));
    }
    if (type.length !== undefined && items.length !== type.length)
      throw new QueryValueError(location, "array length differs from the native contract");
    return items.map((item, index) => {
      if (item === null) {
        if (type.elementNullable === false) {
          if (!encoding && typeof type.array === "object" && "json" in type.array && profile?.jsonWire === "parsed")
            return scalar(item, type.array, `${location}[${index}]`, profile, false, budget, owned);
          throw new QueryValueError(`${location}[${index}]`, "unexpected NULL array element");
        }
        return null;
      }
      return scalar(item, type.array, `${location}[${index}]`, profile, encoding, budget, owned);
    });
  }
  const valid =
    type === "unknown" ||
    (type === "date"
      ? value instanceof Date && Number.isFinite(Date.prototype.getTime.call(value))
      : type === "bytes"
        ? value instanceof Uint8Array
        : typeof value === type);
  if (
    !valid ||
    (typeof value === "number" &&
      (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))))
  )
    throw new QueryValueError(location, `expected ${type}`);
  if (owned && type === "bytes") return new Uint8Array(value as Uint8Array);
  if (owned && type === "date") return new Date(Date.prototype.getTime.call(value));
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
  const source = valueObject(row, `row ${rowIndex}`);
  const result: Record<string, unknown> = {};
  for (const column of plan.columns) {
    if (!Object.hasOwn(source, column.name)) throw new QueryValueError(column.name, "missing result column");
    const value = decode(source[column.name], column, profile, column.name);
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
