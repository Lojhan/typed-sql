import {
  type JsonShape,
  jsonArrayShape,
  jsonObjectShape,
  jsonShapeFromValue,
  jsonTupleShape,
  parseJsonShape,
  unionJsonShapes,
  unknownJsonShape,
} from "@typed-sql/core";

export interface JsonDeclaration {
  readonly shape: JsonShape;
  readonly source: "database" | "application";
}

export function parseJsonDeclaration(value: unknown): JsonDeclaration {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("JSON declaration must be an object");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => key !== "shape" && key !== "source") ||
    (input.source !== "database" && input.source !== "application")
  )
    throw new TypeError("Invalid JSON declaration source or fields");
  return Object.freeze({ shape: parseJsonShape(input.shape), source: input.source });
}

/**
 * Extract the structural TypeScript shape admitted by a JSON Schema.
 * This is a conservative projection, not a replacement for a JSON Schema validator:
 * numeric/string refinements are not represented by TypeScript's primitive types.
 * Unsupported composition is rejected rather than interpreted optimistically.
 */
export function jsonShapeFromSchema(schema: unknown): JsonShape {
  let nodes = 0;
  const active = new Set<object>();
  const parse = (value: unknown, depth: number): JsonShape => {
    if (++nodes > 1024 || depth > 32) throw new TypeError("JSON Schema expansion limit");
    if (value === true) return unknownJsonShape;
    if (value === false) throw new TypeError("Empty JSON Schema cannot be represented as a JSON value shape");
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TypeError("JSON Schema must be an object or boolean");
    if (active.has(value)) throw new TypeError("Recursive JSON Schema requires an explicit runtime validator");
    active.add(value);
    try {
      const source = value as Record<string, unknown>;
      for (const keyword of ["allOf", "not", "if", "then", "else", "dependentSchemas", "$dynamicRef", "$recursiveRef"])
        if (keyword in source) throw new TypeError(`Unsupported JSON Schema composition: ${keyword}`);
      if (source.$ref !== undefined) {
        if (typeof source.$ref !== "string" || !source.$ref.startsWith("#/"))
          throw new TypeError("Only local JSON Schema references are supported");
        let target: unknown = schema;
        for (const part of source.$ref.slice(2).split("/")) {
          const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
          if (typeof target !== "object" || target === null || !Object.hasOwn(target, key))
            throw new TypeError("Unresolved JSON Schema reference");
          target = (target as Record<string, unknown>)[key];
        }
        return parse(target, depth + 1);
      }
      if (source.const !== undefined || Object.hasOwn(source, "const")) return jsonShapeFromValue(source.const);
      if (source.enum !== undefined) {
        if (!Array.isArray(source.enum) || source.enum.length === 0)
          throw new TypeError("JSON Schema enum must be nonempty");
        return unionJsonShapes(source.enum.map((item) => jsonShapeFromValue(item)));
      }
      const alternatives = source.anyOf ?? source.oneOf;
      if (alternatives !== undefined) {
        if (!Array.isArray(alternatives) || alternatives.length === 0)
          throw new TypeError("JSON Schema alternatives must be nonempty");
        return unionJsonShapes(alternatives.map((item) => parse(item, depth + 1)));
      }
      if (Array.isArray(source.type))
        return unionJsonShapes(source.type.map((type) => parse({ ...source, type }, depth + 1)));
      switch (source.type) {
        case undefined:
          return unknownJsonShape;
        case "null":
        case "boolean":
        case "string":
          return Object.freeze({ kind: source.type });
        case "integer":
        case "number":
          return Object.freeze({ kind: "number" });
        case "array": {
          const prefix = source.prefixItems ?? (Array.isArray(source.items) ? source.items : undefined);
          if (prefix !== undefined) {
            if (!Array.isArray(prefix)) throw new TypeError("JSON Schema prefixItems must be an array");
            const members = prefix.map((item) => parse(item, depth + 1));
            const rest = source.prefixItems === undefined ? source.additionalItems : source.items;
            if (rest === false && source.minItems === members.length) return jsonTupleShape(members);
            // Shorter tuples and unrestricted tails need a wider element union.
            return jsonArrayShape(
              unionJsonShapes([...members, ...(rest === false ? [] : [parse(rest ?? true, depth + 1)])]),
            );
          }
          return jsonArrayShape(parse(source.items ?? true, depth + 1));
        }
        case "object": {
          if (source.patternProperties !== undefined || source.unevaluatedProperties !== undefined)
            throw new TypeError("Pattern/unevaluated JSON Schema properties require an explicit validator");
          const properties = source.properties ?? {};
          if (typeof properties !== "object" || properties === null || Array.isArray(properties))
            throw new TypeError("JSON Schema properties must be an object");
          const required = source.required ?? [];
          if (!Array.isArray(required) || required.some((key) => typeof key !== "string"))
            throw new TypeError("JSON Schema required must contain property names");
          const names = new Set(required as string[]);
          const fields = Object.fromEntries(
            Object.entries(properties).map(([key, child]) => [
              key,
              { shape: parse(child, depth + 1), ...(names.has(key) ? {} : { optional: true }) },
            ]),
          );
          const additional =
            source.additionalProperties === false ? undefined : parse(source.additionalProperties ?? true, depth + 1);
          for (const key of names)
            if (!Object.hasOwn(fields, key)) {
              if (additional === undefined)
                throw new TypeError("Required JSON Schema property is forbidden by additionalProperties");
              Object.defineProperty(fields, key, {
                value: { shape: additional },
                enumerable: true,
                configurable: true,
              });
            }
          return jsonObjectShape(fields, additional);
        }
        default:
          throw new TypeError("Invalid JSON Schema type");
      }
    } finally {
      active.delete(value);
    }
  };
  return parse(schema, 0);
}
