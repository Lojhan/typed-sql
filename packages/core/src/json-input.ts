import { validateJsonValue } from "./json.js";

declare const jsonInputBrand: unique symbol;
/** Logical input type of an explicitly serialized JSON binding. */
export interface JsonInput<Value> {
  readonly [jsonInputBrand]: Value;
}

const inputs = new WeakMap<object, string>();

/** Snapshot finite JSON, including JSON null, for positional factories or tagged queries. */
export function jsonValue<Value>(value: Value): JsonInput<Value> {
  if (!validateJsonValue(value)) throw new TypeError("JSON bindings require a finite, acyclic JSON value");
  const text = JSON.stringify(value);
  if (typeof text !== "string") throw new TypeError("JSON binding did not serialize to JSON text");
  const input = Object.freeze({});
  inputs.set(input, text);
  return input as JsonInput<Value>;
}

/** @internal Only values created by jsonValue() carry this encoding protocol. */
export function serializedJsonInput(value: unknown): string | undefined {
  return typeof value === "object" && value !== null ? inputs.get(value) : undefined;
}
