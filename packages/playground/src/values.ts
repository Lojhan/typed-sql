import type { WireValue } from "./value-types.js";

export type { WireValue } from "./value-types.js";

/** Tagged containers avoid collisions; incremental budgets bound transport before constructing a large result. */
export function encodeValue(
  value: unknown,
  options: { readonly maxBytes?: number; readonly maxNodes?: number } = {},
): WireValue {
  let bytes = 0;
  let nodes = 0;
  const seen = new Set<object>();
  const charge = (amount: number) => {
    bytes += amount;
    if (bytes > (options.maxBytes ?? 5 * 1024 * 1024)) throw new RangeError("Result exceeds the configured byte limit");
    if (++nodes > (options.maxNodes ?? 100_000)) throw new RangeError("Result exceeds the structured-value node limit");
  };
  const visit = (item: unknown, depth: number): WireValue => {
    if (depth > 30) throw new RangeError("Result exceeds the maximum structured-value depth");
    charge(8);
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") {
      charge(Buffer.byteLength(item));
      return item;
    }
    if (typeof item === "number") return Number.isFinite(item) ? item : { kind: "number", value: String(item) };
    if (typeof item === "bigint") {
      const text = item.toString();
      charge(text.length);
      return { kind: "bigint", value: text };
    }
    if (item === undefined) return { kind: "undefined" };
    if (typeof item !== "object")
      throw new TypeError("Results must contain serializable data, not functions or symbols");
    if (item instanceof Date) return { kind: "date", value: item.toISOString() };
    if (item instanceof Uint8Array) {
      charge(Math.ceil((item.byteLength * 4) / 3));
      return { kind: "bytes", value: Buffer.from(item).toString("base64") };
    }
    if (seen.has(item)) throw new TypeError("Cyclic results cannot be displayed");
    seen.add(item);
    try {
      if (Array.isArray(item)) return { kind: "array", items: item.map((child) => visit(child, depth + 1)) };
      const prototype: unknown = Object.getPrototypeOf(item);
      if (prototype !== null && prototype !== Object.prototype)
        throw new TypeError("Return plain data, arrays, dates, or bytes");
      return {
        kind: "object",
        entries: Object.keys(item).map((key) => {
          charge(Buffer.byteLength(key));
          return [key, visit(Reflect.get(item, key), depth + 1)] as const;
        }),
      };
    } finally {
      seen.delete(item);
    }
  };
  return visit(value, 0);
}

export function decodeValue(value: WireValue): unknown {
  let count = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++count > 100_000 || depth > 30) throw new TypeError("Invalid structured-value bounds");
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("Use an explicit tagged non-finite number");
      return item;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError("Invalid typed value");
    const data = item as Record<string, unknown>;
    switch (data.kind) {
      case "undefined":
        return undefined;
      case "bigint":
        if (typeof data.value === "string" && /^-?\d+$/u.test(data.value)) return BigInt(data.value);
        break;
      case "date":
        if (typeof data.value === "string" && Number.isFinite(new Date(data.value).getTime()))
          return new Date(data.value);
        break;
      case "bytes":
        if (
          typeof data.value === "string" &&
          /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(data.value)
        )
          return Buffer.from(data.value, "base64");
        break;
      case "number":
        if (typeof data.value === "string" && ["NaN", "Infinity", "-Infinity"].includes(data.value))
          return Number(data.value);
        break;
      case "array":
        if (Array.isArray(data.items)) return data.items.map((child) => visit(child, depth + 1));
        break;
      case "object":
        if (Array.isArray(data.entries))
          return Object.fromEntries(
            data.entries.map((entry) => {
              if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string")
                throw new TypeError("Invalid object entry");
              return [entry[0], visit(entry[1], depth + 1)];
            }),
          );
        break;
    }
    throw new TypeError("Invalid typed-value descriptor");
  };
  return visit(value, 0);
}
