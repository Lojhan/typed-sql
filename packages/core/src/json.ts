/** A JSON value's structure, independent of its SQL type and wire representation. */
export type JsonShape =
  | { readonly kind: "unknown" | "null" | "boolean" | "number" | "string" }
  | { readonly kind: "literal"; readonly value: string | number | boolean }
  | {
      readonly kind: "object";
      readonly properties: Readonly<Record<string, JsonShapeProperty>>;
      readonly additionalProperties?: JsonShape;
    }
  | { readonly kind: "array"; readonly element: JsonShape }
  | { readonly kind: "tuple"; readonly elements: readonly JsonShape[] }
  | { readonly kind: "union"; readonly variants: readonly JsonShape[] };

export interface JsonShapeProperty {
  readonly shape: JsonShape;
  readonly optional?: boolean;
}

/** SQL nullability belongs to the enclosing column/parameter, not to this descriptor. */
export interface JsonValueDescriptor {
  readonly shape: JsonShape;
  readonly representation: "parsed" | "text" | "binary";
}

export const JSON_SHAPE_LIMITS = Object.freeze({ maximumDepth: 32, maximumNodes: 1_024, maximumTypeLength: 16_384 });
export const unknownJsonShape: JsonShape = Object.freeze({ kind: "unknown" });
export const nullJsonShape: JsonShape = Object.freeze({ kind: "null" });

/** Render bounded type text. Cyclic, excessively deep or expanded structures fail closed. */
export function jsonShapeType(shape: JsonShape): string {
  let nodes = 0;
  let length = 0;
  const active = new Set<JsonShape>();
  const append = (text: string): string => {
    length += text.length;
    if (length > JSON_SHAPE_LIMITS.maximumTypeLength) throw new RangeError("JSON shape type limit");
    return text;
  };
  const render = (value: JsonShape, depth: number): string => {
    if (++nodes > JSON_SHAPE_LIMITS.maximumNodes || depth > JSON_SHAPE_LIMITS.maximumDepth || active.has(value))
      throw new RangeError("JSON shape expansion limit");
    active.add(value);
    let result: string;
    switch (value.kind) {
      case "unknown":
      case "null":
      case "boolean":
      case "number":
      case "string":
        result = append(value.kind);
        break;
      case "literal":
        if (typeof value.value === "number" && !Number.isFinite(value.value)) throw new TypeError("Non-JSON number");
        result = append(JSON.stringify(value.value));
        break;
      case "array":
        result = append("readonly (") + render(value.element, depth + 1) + append(")[]");
        break;
      case "tuple":
        result =
          append("readonly [") + value.elements.map((item) => render(item, depth + 1)).join(append(", ")) + append("]");
        break;
      case "union":
        result = value.variants.map((item) => render(item, depth + 1)).join(append(" | "));
        break;
      case "object": {
        const fields = Object.entries(value.properties).map(
          ([key, property]) =>
            append(`${JSON.stringify(key)}${property.optional ? "?" : ""}: `) +
            render(property.shape, depth + 1) +
            append("; "),
        );
        if (value.additionalProperties !== undefined) {
          const members = [
            value.additionalProperties,
            ...Object.values(value.properties).map((property) => property.shape),
          ];
          const types = [...new Set(members.map((member) => render(member, depth + 1)))];
          fields.push(
            append("[key: string]: ") +
              (types.includes("unknown") ? "unknown" : types.join(append(" | ")) + append(" | undefined")) +
              append("; "),
          );
        }
        result = append("{ ") + fields.join("") + append("}");
        break;
      }
    }
    active.delete(value);
    return result;
  };
  try {
    const result = render(shape, 0);
    return result.length > JSON_SHAPE_LIMITS.maximumTypeLength ? "unknown" : result || "unknown";
  } catch {
    return "unknown";
  }
}

/** Normalize a union without expanding recursive type text beyond the shared budget. */
export function unionJsonShapes(shapes: readonly JsonShape[]): JsonShape {
  const variants: JsonShape[] = [];
  const keys = new Set<string>();
  let visited = 0;
  const add = (shape: JsonShape, depth: number): boolean => {
    if (
      ++visited > JSON_SHAPE_LIMITS.maximumNodes ||
      depth > JSON_SHAPE_LIMITS.maximumDepth ||
      shape.kind === "unknown"
    )
      return false;
    if (shape.kind === "union") return shape.variants.every((variant) => add(variant, depth + 1));
    const key = jsonShapeType(shape);
    if (key === "unknown") return false;
    if (!keys.has(key)) {
      keys.add(key);
      variants.push(shape);
    }
    return true;
  };
  if (!shapes.every((shape) => add(shape, 0))) return unknownJsonShape;
  if (variants.length === 0) return unknownJsonShape;
  return variants.length === 1 ? variants[0]! : Object.freeze({ kind: "union", variants: Object.freeze(variants) });
}

export function jsonObjectShape(
  properties: Readonly<Record<string, JsonShapeProperty>>,
  additionalProperties?: JsonShape,
): JsonShape {
  if (Object.keys(properties).length > JSON_SHAPE_LIMITS.maximumNodes) return unknownJsonShape;
  return Object.freeze({
    kind: "object",
    properties: Object.freeze({ ...properties }),
    ...(additionalProperties === undefined ? {} : { additionalProperties }),
  });
}

export function jsonArrayShape(element: JsonShape): JsonShape {
  return Object.freeze({ kind: "array", element });
}
export function jsonTupleShape(elements: readonly JsonShape[]): JsonShape {
  return elements.length > JSON_SHAPE_LIMITS.maximumNodes
    ? unknownJsonShape
    : Object.freeze({ kind: "tuple", elements: Object.freeze([...elements]) });
}

/** Convert a known JSON document, preserving literal values and exact array positions. */
export function jsonShapeFromValue(value: unknown): JsonShape {
  let nodes = 0;
  const active = new Set<object>();
  const convert = (item: unknown, depth: number): JsonShape => {
    if (++nodes > JSON_SHAPE_LIMITS.maximumNodes || depth > JSON_SHAPE_LIMITS.maximumDepth)
      throw new RangeError("JSON document shape limit");
    if (item === null) return nullJsonShape;
    if (typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)))
      return Object.freeze({ kind: "literal", value: item });
    if (typeof item !== "object" || active.has(item)) throw new TypeError("Invalid JSON document value");
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new TypeError("JSON documents contain only plain objects");
    active.add(item);
    const result = Array.isArray(item)
      ? jsonTupleShape(item.map((entry) => convert(entry, depth + 1)))
      : jsonObjectShape(
          Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, { shape: convert(entry, depth + 1) }])),
        );
    active.delete(item);
    return result;
  };
  try {
    return convert(value, 0);
  } catch {
    return unknownJsonShape;
  }
}

export interface JsonShapePathResult {
  readonly shape: JsonShape;
  readonly presence: "always" | "maybe" | "never";
}

/** Numeric components address array offsets; negative offsets count from the end. */
export function jsonShapeAtPath(shape: JsonShape, path: readonly (string | number)[]): JsonShapePathResult {
  let nodes = 0;
  const walk = (value: JsonShape, offset: number): JsonShapePathResult => {
    if (++nodes > JSON_SHAPE_LIMITS.maximumNodes || offset > JSON_SHAPE_LIMITS.maximumDepth)
      return { shape: unknownJsonShape, presence: "maybe" };
    if (offset === path.length) return { shape: value, presence: "always" };
    if (value.kind === "unknown") return { shape: value, presence: "maybe" };
    if (value.kind === "union") {
      const branches = value.variants.map((variant) => walk(variant, offset));
      const present = branches.filter((branch) => branch.presence !== "never");
      return {
        shape: unionJsonShapes(present.map((branch) => branch.shape)),
        presence:
          present.length === 0
            ? "never"
            : branches.every((branch) => branch.presence === "always")
              ? "always"
              : "maybe",
      };
    }
    const key = path[offset]!;
    let child: JsonShape | undefined;
    let maybe = false;
    if (value.kind === "object" && typeof key === "string") {
      const property = Object.hasOwn(value.properties, key) ? value.properties[key] : undefined;
      child = property?.shape ?? value.additionalProperties;
      maybe = property === undefined || property.optional === true;
    } else if (typeof key === "number" && Number.isSafeInteger(key)) {
      if (value.kind === "tuple") child = value.elements[key < 0 ? value.elements.length + key : key];
      else if (value.kind === "array") {
        child = value.element;
        maybe = true;
      }
    }
    if (child === undefined) return { shape: unknownJsonShape, presence: "never" };
    const result = walk(child, offset + 1);
    return { ...result, presence: result.presence === "never" ? "never" : maybe ? "maybe" : result.presence };
  };
  return walk(shape, 0);
}

/** Immutable structural path update. Grammars decide path parsing and SQL-specific creation rules. */
export function updateJsonShapePath(
  shape: JsonShape,
  path: readonly (string | number)[],
  value: JsonShape | undefined,
  mode: "set" | "insert" | "replace" = "set",
): JsonShape {
  if (path.length > JSON_SHAPE_LIMITS.maximumDepth) return unknownJsonShape;
  let nodes = 0;
  const update = (node: JsonShape, offset: number): JsonShape => {
    if (++nodes > JSON_SHAPE_LIMITS.maximumNodes) return unknownJsonShape;
    if (offset === path.length) return value ?? unknownJsonShape;
    if (node.kind === "unknown") return node;
    if (node.kind === "union") return unionJsonShapes(node.variants.map((variant) => update(variant, offset)));
    const key = path[offset]!;
    const leaf = offset === path.length - 1;
    if (node.kind === "object" && typeof key === "string") {
      const property = Object.hasOwn(node.properties, key) ? node.properties[key] : undefined;
      if (property === undefined && (!leaf || mode === "replace")) return node;
      if (property !== undefined && leaf && mode === "insert") return node;
      const properties = { ...node.properties };
      if (leaf && value === undefined) delete properties[key];
      else
        Object.defineProperty(properties, key, {
          value: {
            shape: leaf ? value! : update(property!.shape, offset + 1),
            ...(property?.optional ? { optional: true } : {}),
          },
          enumerable: true,
          configurable: true,
          writable: true,
        });
      return jsonObjectShape(properties, node.additionalProperties);
    }
    if (typeof key === "number" && Number.isSafeInteger(key)) {
      if (node.kind === "tuple") {
        const index = key < 0 ? node.elements.length + key : key;
        if (
          index < 0 ||
          index > node.elements.length ||
          (index === node.elements.length && (!leaf || mode === "replace" || value === undefined))
        )
          return node;
        if (index < node.elements.length && leaf && mode === "insert") return node;
        const elements = [...node.elements];
        if (leaf && value === undefined) elements.splice(index, 1);
        else elements[index] = leaf ? value! : update(elements[index]!, offset + 1);
        return jsonTupleShape(elements);
      }
      if (node.kind === "array")
        return value === undefined
          ? node
          : jsonArrayShape(unionJsonShapes([node.element, leaf ? value : update(node.element, offset + 1)]));
    }
    return node;
  };
  return update(shape, 0);
}

/** Validate serialized shape metadata without trusting casts, prototypes or unbounded recursion. */
export function parseJsonShape(value: unknown): JsonShape {
  let nodes = 0;
  const object = (item: unknown): Record<string, unknown> => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new TypeError("JSON shape must be an object");
    return item as Record<string, unknown>;
  };
  const fields = (item: Record<string, unknown>, allowed: readonly string[]): void => {
    if (Object.keys(item).some((key) => !allowed.includes(key))) throw new TypeError("Unknown JSON shape field");
  };
  const parse = (item: unknown, depth: number): JsonShape => {
    if (++nodes > JSON_SHAPE_LIMITS.maximumNodes || depth > JSON_SHAPE_LIMITS.maximumDepth)
      throw new RangeError("JSON shape metadata limit");
    const source = object(item);
    switch (source.kind) {
      case "unknown":
      case "null":
      case "boolean":
      case "number":
      case "string":
        fields(source, ["kind"]);
        return Object.freeze({ kind: source.kind });
      case "literal":
        fields(source, ["kind", "value"]);
        if (
          typeof source.value !== "string" &&
          typeof source.value !== "boolean" &&
          !(typeof source.value === "number" && Number.isFinite(source.value))
        )
          throw new TypeError("Invalid JSON shape literal");
        return Object.freeze({ kind: "literal", value: source.value });
      case "array":
        fields(source, ["kind", "element"]);
        return jsonArrayShape(parse(source.element, depth + 1));
      case "tuple":
      case "union": {
        const key = source.kind === "tuple" ? "elements" : "variants";
        fields(source, ["kind", key]);
        const members = source[key];
        if (
          !Array.isArray(members) ||
          members.length > JSON_SHAPE_LIMITS.maximumNodes ||
          (key === "variants" && members.length === 0)
        )
          throw new TypeError("Invalid JSON shape members");
        const values = members.map((member) => parse(member, depth + 1));
        return source.kind === "tuple" ? jsonTupleShape(values) : unionJsonShapes(values);
      }
      case "object": {
        fields(source, ["kind", "properties", "additionalProperties"]);
        const properties = object(source.properties);
        if (Object.keys(properties).length > JSON_SHAPE_LIMITS.maximumNodes)
          throw new RangeError("JSON object shape property limit");
        const entries = Object.entries(properties).map(([key, entry]) => {
          const property = object(entry);
          fields(property, ["shape", "optional"]);
          if (property.optional !== undefined && typeof property.optional !== "boolean")
            throw new TypeError("Invalid JSON property optionality");
          return [
            key,
            Object.freeze({
              shape: parse(property.shape, depth + 1),
              ...(property.optional === true ? { optional: true } : {}),
            }),
          ] as const;
        });
        return jsonObjectShape(
          Object.fromEntries(entries),
          source.additionalProperties === undefined ? undefined : parse(source.additionalProperties, depth + 1),
        );
      }
      default:
        throw new TypeError("Invalid JSON shape kind");
    }
  };
  return parse(value, 0);
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export interface JsonValidationLimits {
  readonly maximumDepth?: number;
  readonly maximumValues?: number;
}

/** Unknown structure still requires a finite, acyclic JSON value rather than an arbitrary JS object. */
export function validateJsonValue(
  value: unknown,
  shape: JsonShape = unknownJsonShape,
  limits: JsonValidationLimits = {},
): value is JsonValue {
  const maximumDepth = limits.maximumDepth ?? 128;
  const maximumValues = limits.maximumValues ?? 1_000_000;
  if (
    !Number.isSafeInteger(maximumDepth) ||
    maximumDepth < 1 ||
    !Number.isSafeInteger(maximumValues) ||
    maximumValues < 1
  )
    return false;
  let values = 0;
  const active = new Set<object>();
  const valid = (item: unknown, depth: number): boolean => {
    if (++values > maximumValues || depth > maximumDepth) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || active.has(item)) return false;
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      return false;
    active.add(item);
    let result = true;
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) {
        if (!Object.hasOwn(item, index) || !valid(item[index], depth + 1)) {
          result = false;
          break;
        }
      }
    } else result = Object.values(item).every((entry) => valid(entry, depth + 1));
    active.delete(item);
    return result;
  };
  if (!valid(value, 0)) return false;
  let checks = 0;
  const matches = (item: JsonValue, expected: JsonShape, depth: number): boolean => {
    if (++checks > maximumValues || depth > JSON_SHAPE_LIMITS.maximumDepth) return false;
    switch (expected.kind) {
      case "unknown":
        return true;
      case "null":
        return item === null;
      case "boolean":
      case "number":
      case "string":
        return typeof item === expected.kind;
      case "literal":
        return item === expected.value;
      case "union":
        return expected.variants.some((variant) => matches(item, variant, depth + 1));
      case "array":
        return Array.isArray(item) && item.every((entry) => matches(entry, expected.element, depth + 1));
      case "tuple":
        return (
          Array.isArray(item) &&
          item.length === expected.elements.length &&
          item.every((entry, index) => matches(entry, expected.elements[index]!, depth + 1))
        );
      case "object": {
        if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
        const object = item as { readonly [key: string]: JsonValue };
        for (const [key, property] of Object.entries(expected.properties)) {
          if (!Object.hasOwn(object, key)) {
            if (!property.optional) return false;
          } else if (!matches(object[key]!, property.shape, depth + 1)) return false;
        }
        for (const key of Object.keys(object)) {
          if (Object.hasOwn(expected.properties, key)) continue;
          if (
            expected.additionalProperties === undefined ||
            !matches(object[key]!, expected.additionalProperties, depth + 1)
          )
            return false;
        }
        return true;
      }
    }
  };
  return matches(value as JsonValue, shape, 0);
}
