import { jsonShapeType, type QueryValueDescriptor, type RuntimeValueType } from "@typed-sql/core";

/** Derive syntax from validated runtime descriptors, never arbitrary cached TypeScript text. */
export function contractTypeScriptType(value: QueryValueDescriptor): string {
  const json = value.json;
  if (json)
    return json.representation === "text"
      ? "string"
      : json.representation === "binary"
        ? "Uint8Array"
        : jsonShapeType(json.shape);
  return type(value.type);
}
function field(value: { readonly type: RuntimeValueType; readonly nullable: boolean }): string {
  return `${type(value.type)}${value.nullable ? " | null" : ""}`;
}
function type(value: RuntimeValueType): string {
  if (typeof value === "string") return value === "date" ? "Date" : value === "bytes" ? "Uint8Array" : value;
  if ("json" in value) return contractTypeScriptType({ type: "unknown", nullable: false, json: value.json });
  if ("literal" in value) return JSON.stringify(value.literal);
  if ("array" in value) return `readonly (${type(value.array)}${value.elementNullable !== false ? " | null" : ""})[]`;
  if ("tuple" in value) return `readonly [${value.tuple.map(field).join(", ")}]`;
  if ("union" in value) return value.union.map((item) => `(${type(item)})`).join(" | ");
  return `{ ${Object.entries(value.object)
    .map(([name, item]) => `${JSON.stringify(name)}: ${field(item)};`)
    .join(" ")} }`;
}
