import { type DuckDBType, formatDuckDBType } from "./native-types.js";
/** Native SDK union construction loses typed NULL payloads. Lower only structural bind markers. */
export interface DuckDBParameterTransport {
  readonly wireType: DuckDBType;
  encode(value: unknown): unknown;
  placeholder(marker: string): string;
}
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`,
  literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function hasUnion(type: DuckDBType): boolean {
  switch (type.kind) {
    case "union":
      return true;
    case "list":
    case "array":
      return hasUnion(type.element);
    case "struct":
      return type.fields.some((field) => hasUnion(field.type));
    case "tuple":
      return type.elements.some(hasUnion);
    case "map":
      return hasUnion(type.key) || hasUnion(type.value);
    default:
      return false;
  }
}
export function duckDBParameterTransport(type: DuckDBType): DuckDBParameterTransport {
  if (!hasUnion(type)) return { wireType: type, encode: (value) => value, placeholder: (marker) => marker };
  let ordinal = 0;
  let planned = 0;
  let witnesses: DuckDBType[] = [];
  const plan = (target: DuckDBType, rootMarker: string): DuckDBParameterTransport => {
    if (++planned > 16384) throw new RangeError("DuckDB physical type expansion limit");
    if (!hasUnion(target)) return { wireType: target, encode: (value) => value, placeholder: (marker) => marker };
    const witness = `(${rootMarker}).${identifier(`__typed_sql_type_${witnesses.length}`)}`;
    witnesses.push(target);
    const cast = (value: string) => `cast_to_type(${value}, ${witness})`;
    const bounded = (text: string) => {
      if (text.length > 1048576) throw new RangeError("DuckDB physical parameter lowering limit");
      return text;
    };
    switch (target.kind) {
      case "union": {
        const members = target.fields.map((field) => ({
          name: field.name,
          plan: plan(field.type, rootMarker),
        }));
        return {
          wireType: {
            kind: "struct",
            fields: [
              { name: "__typed_sql_tag", type: { kind: "scalar", name: "VARCHAR" } },
              ...members.map((member, i) => ({ name: `__typed_sql_${i}`, type: member.plan.wireType })),
            ],
          },
          encode(value) {
            if (value === null) return null;
            const input = value as { tag: string; value: unknown };
            return Object.fromEntries([
              ["__typed_sql_tag", input.tag],
              ...members.map((member, i) => [
                `__typed_sql_${i}`,
                member.name === input.tag ? member.plan.encode(input.value) : null,
              ]),
            ]);
          },
          placeholder(marker) {
            return bounded(
              cast(
                `CASE ${members.map((member, i) => `WHEN (${marker}).${identifier("__typed_sql_tag")} = ${literal(member.name)} THEN ${cast(`union_value(${identifier(member.name)} := ${member.plan.placeholder(`(${marker}).${identifier(`__typed_sql_${i}`)}`)})`)}`).join(" ")} ELSE NULL END`,
              ),
            );
          },
        };
      }
      case "list":
      case "array": {
        const child = plan(target.element, rootMarker),
          variable = `__typed_sql_element_${ordinal++}`;
        return {
          wireType:
            target.kind === "list"
              ? { kind: "list", element: child.wireType }
              : { kind: "array", element: child.wireType, length: target.length },
          encode(value) {
            return value === null ? null : (value as readonly unknown[]).map((item) => child.encode(item));
          },
          placeholder(marker) {
            return bounded(cast(`list_transform(${marker}, lambda ${variable}: ${child.placeholder(variable)})`));
          },
        };
      }
      case "struct": {
        const fields = target.fields.map((field) => ({
          name: field.name,
          plan: plan(field.type, rootMarker),
        }));
        return {
          wireType: {
            kind: "struct",
            fields: fields.map((field) => ({ name: field.name, type: field.plan.wireType })),
          },
          encode(value) {
            return value === null
              ? null
              : Object.fromEntries(
                  fields.map((field) => [
                    field.name,
                    field.plan.encode((value as Record<string, unknown>)[field.name]),
                  ]),
                );
          },
          placeholder(marker) {
            return bounded(
              cast(
                `CASE WHEN (${marker}) IS NULL THEN NULL ELSE struct_pack(${fields.map((field) => `${identifier(field.name)} := ${field.plan.placeholder(`(${marker}).${identifier(field.name)}`)}`).join(", ")}) END`,
              ),
            );
          },
        };
      }
      case "tuple": {
        const elements = target.elements.map((element) => plan(element, rootMarker));
        return {
          wireType: { kind: "tuple", elements: elements.map((item) => item.wireType) },
          encode(value) {
            return value === null ? null : (value as readonly unknown[]).map((item, i) => elements[i]!.encode(item));
          },
          placeholder(marker) {
            return bounded(
              cast(
                `CASE WHEN (${marker}) IS NULL THEN NULL ELSE row(${elements.map((element, i) => element.placeholder(`(${marker})[${i + 1}]`)).join(", ")}) END`,
              ),
            );
          },
        };
      }
      case "map": {
        const key = plan(target.key, rootMarker),
          value = plan(target.value, rootMarker),
          variable = `__typed_sql_map_${ordinal++}`;
        return {
          wireType: { kind: "map", key: key.wireType, value: value.wireType },
          encode(input) {
            return input === null
              ? null
              : (input as readonly (readonly [unknown, unknown])[]).map(([k, v]) => [key.encode(k), value.encode(v)]);
          },
          placeholder(marker) {
            return bounded(
              cast(
                `CASE WHEN (${marker}) IS NULL THEN NULL ELSE map(list_transform(map_keys(${marker}), lambda ${variable}: ${key.placeholder(variable)}), list_transform(map_values(${marker}), lambda ${variable}: ${value.placeholder(variable)})) END`,
              ),
            );
          },
        };
      }
      default:
        return { wireType: target, encode: (value) => value, placeholder: (marker) => marker };
    }
  };
  const payload = plan(type, "NULL");
  const wireType: DuckDBType = {
    kind: "struct",
    fields: [
      { name: "__typed_sql_payload", type: payload.wireType },
      ...witnesses.map((witness, i) => ({ name: `__typed_sql_type_${i}`, type: witness })),
    ],
  };
  let nodes = 0;
  const visit = (value: DuckDBType, depth: number): void => {
    if (++nodes > 16384 || depth > 128) throw new RangeError("DuckDB physical type expansion limit");
    switch (value.kind) {
      case "list":
      case "array":
        visit(value.element, depth + 1);
        break;
      case "tuple":
        for (const child of value.elements) visit(child, depth + 1);
        break;
      case "struct":
      case "union":
        for (const child of value.fields) visit(child.type, depth + 1);
        break;
      case "map":
        visit(value.key, depth + 1);
        visit(value.value, depth + 1);
        break;
    }
  };
  visit(wireType, 0);
  if (new TextEncoder().encode(formatDuckDBType(wireType)).byteLength > 1048576)
    throw new RangeError("DuckDB physical type text limit");
  return {
    wireType,
    encode(value) {
      return Object.fromEntries([
        ["__typed_sql_payload", payload.encode(value)],
        ...witnesses.map((_, i) => [`__typed_sql_type_${i}`, null]),
      ]);
    },
    placeholder(marker) {
      ordinal = 0;
      planned = 0;
      witnesses = [];
      return plan(type, marker).placeholder(`(${marker}).${identifier("__typed_sql_payload")}`);
    },
  };
}
