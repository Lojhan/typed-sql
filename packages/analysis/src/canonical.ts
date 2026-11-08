import { createHash } from "node:crypto";

/** Data-only canonicalization: no getters, executable values, cycles or unbounded traversal. */
export function canonicalContractData(value: unknown): string {
  const active = new Set<object>();
  let nodes = 262_144,
    text = 8 * 1024 * 1024;
  const visit = (input: unknown, depth: number): unknown => {
    if (--nodes < 0 || depth > 64) throw new TypeError("Query contract exceeds structural limits");
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") {
      text -= Buffer.byteLength(input);
      if (text < 0) throw new TypeError("Query contract exceeds text limits");
      return input;
    }
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input !== "object" || input === null) throw new TypeError("Query contract must contain JSON data");
    if (active.has(input)) throw new TypeError("Cyclic query contract");
    if (!Array.isArray(input) && ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
      throw new TypeError("Query contract must contain plain data objects");
    active.add(input);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (Object.getOwnPropertySymbols(input).length || Object.values(descriptors).some((field) => !("value" in field)))
        throw new TypeError("Query contract cannot contain symbols or accessors");
      if (Array.isArray(input)) {
        if (input.length > 65_535 || Object.keys(input).length !== input.length)
          throw new TypeError("Invalid query contract array");
        return Array.from({ length: input.length }, (_, index) => visit(descriptors[String(index)]?.value, depth + 1));
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(descriptors).sort()) {
        visit(key, depth + 1);
        result[key] = visit(descriptors[key]!.value, depth + 1);
      }
      return result;
    } finally {
      active.delete(input);
    }
  };
  return JSON.stringify(visit(value, 0));
}

export function queryContractDigest(value: unknown): string {
  return createHash("sha256").update(canonicalContractData(value)).digest("hex");
}

export function exactSqlDigest(sql: string): string {
  if (Buffer.byteLength(sql) > 8 * 1024 * 1024) throw new TypeError("Query SQL exceeds contract limits");
  return createHash("sha256").update(sql).digest("hex");
}
