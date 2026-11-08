import { type DuckDBType, formatDuckDBType, parseDuckDBType } from "../native-types.js";
import type { DuckDBCatalog } from "./profile.js";
import type { DuckDBBuiltinSignature } from "./types.js";

interface Pattern {
  readonly name: string;
  readonly children?: readonly Pattern[];
  readonly arrayLength?: number | "any";
}
function split(source: string): string[] {
  const result: string[] = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "(") depth++;
    if (source[i] === ")") depth--;
    if (source[i] === "," && depth === 0) {
      result.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  result.push(source.slice(start).trim());
  return result;
}
function pattern(source: string): Pattern {
  const suffix = /\[(\d*|ANY)\]$/u.exec(source);
  if (suffix)
    return {
      name: suffix[1] === "" ? "list" : "array",
      children: [pattern(source.slice(0, suffix.index))],
      ...(suffix[1] === "" ? {} : { arrayLength: suffix[1] === "ANY" ? "any" : Number(suffix[1]) }),
    };
  if (source.startsWith("MAP(") || source.startsWith("TUPLE(")) {
    const open = source.indexOf("(");
    return { name: source.slice(0, open), children: split(source.slice(open + 1, -1)).map(pattern) };
  }
  if (/^STRUCT\([KVT](?:,\s*[KVT])*\)$/u.test(source))
    return { name: "TUPLE", children: split(source.slice(7, -1)).map(pattern) };
  if (source.startsWith("STRUCT(")) return { name: source };
  return { name: source };
}
const cache = new Map<string, Pattern>();
function readPattern(source: string): Pattern {
  let result = cache.get(source);
  if (!result) {
    result = pattern(source);
    cache.set(source, result);
  }
  return result;
}
function same(a: DuckDBType, b: DuckDBType): boolean {
  return formatDuckDBType(a) === formatDuckDBType(b);
}
function match(
  expected: Pattern,
  actual: DuckDBType,
  bindings: Map<string, DuckDBType>,
  catalog: DuckDBCatalog,
): number | undefined {
  if (actual.kind === "scalar" && (actual.name === "NULL" || actual.name === "ANY")) return 50;
  if (["T", "K", "V"].includes(expected.name)) {
    const old = bindings.get(expected.name);
    if (old && !same(old, actual)) return undefined;
    bindings.set(expected.name, actual);
    return 1;
  }
  if (expected.name === "ANY") return 10;
  if (expected.name === "list" || expected.name === "array") {
    if (actual.kind !== "list" && actual.kind !== "array") return undefined;
    if (
      expected.name === "array" &&
      (actual.kind !== "array" || (expected.arrayLength !== "any" && expected.arrayLength !== actual.length))
    )
      return undefined;
    return match(expected.children![0]!, actual.element, bindings, catalog);
  }
  if (expected.name === "MAP") {
    if (actual.kind !== "map") return undefined;
    const key = match(expected.children![0]!, actual.key, bindings, catalog),
      value = match(expected.children![1]!, actual.value, bindings, catalog);
    return key === undefined || value === undefined ? undefined : key + value;
  }
  if (expected.name === "TUPLE" && expected.children) {
    const elements =
      actual.kind === "tuple"
        ? actual.elements
        : actual.kind === "struct"
          ? actual.fields.map((field) => field.type)
          : undefined;
    if (!elements || elements.length !== expected.children.length) return undefined;
    let score = 0;
    for (let i = 0; i < elements.length; i++) {
      const value = match(expected.children[i]!, elements[i]!, bindings, catalog);
      if (value === undefined) return undefined;
      score += value;
    }
    return score;
  }
  if (["STRUCT", "UNION", "TUPLE"].includes(expected.name))
    return actual.kind === expected.name.toLowerCase() ? 1 : undefined;
  let target: DuckDBType;
  try {
    target = parseDuckDBType(expected.name);
  } catch {
    return undefined;
  }
  if (target.kind === "scalar" && actual.kind === "scalar") {
    if (target.name === actual.name) return 0;
    // Native target costs are stable in the qualified v1.5.6/v2.0.0 cast_rules.cpp.
    // https://github.com/duckdb/duckdb/blob/v2.0.0/src/function/cast_rules.cpp
    const costs: Readonly<Record<string, number>> = {
      BIGINT: 101,
      INTEGER: 102,
      HUGEINT: 103,
      DOUBLE: 104,
      DECIMAL: 105,
      BIGNUM: 106,
      TIMESTAMP_NS: 119,
      TIMESTAMP: 120,
      TIMESTAMP_MS: 121,
      TIMESTAMP_S: 122,
      TIMESTAMPTZ: 123,
      TIMESTAMPTZ_NS: 124,
      VARCHAR: 149,
    };
    return catalog.scalarImplicitCast(actual.name, target.name) ? (costs[target.name] ?? 110) : undefined;
  }
  return same(target, actual) ? 0 : undefined;
}
function resultType(expected: Pattern, bindings: Map<string, DuckDBType>): DuckDBType | undefined {
  if (
    ["ANY", "DECIMAL", "STRUCT", "UNION", "MAP", "TUPLE", "LAMBDA", "TABLE", "LIST"].includes(expected.name) &&
    !expected.children
  )
    return undefined;
  if (["T", "K", "V"].includes(expected.name)) return bindings.get(expected.name);
  if (expected.name === "list" || expected.name === "array") {
    const child = resultType(expected.children![0]!, bindings);
    if (!child) return undefined;
    return expected.name === "list"
      ? { kind: "list", element: child }
      : typeof expected.arrayLength === "number"
        ? { kind: "array", element: child, length: expected.arrayLength }
        : undefined;
  }
  if (expected.name === "MAP") {
    const key = resultType(expected.children![0]!, bindings),
      value = resultType(expected.children![1]!, bindings);
    return key && value ? { kind: "map", key, value } : undefined;
  }
  if (expected.name === "TUPLE" && expected.children) {
    const elements = expected.children.map((child) => resultType(child, bindings));
    return elements.every((type): type is DuckDBType => type !== undefined) ? { kind: "tuple", elements } : undefined;
  }
  try {
    return parseDuckDBType(expected.name);
  } catch {
    return undefined;
  }
}
export interface DuckDBBuiltinMatch {
  readonly signature: DuckDBBuiltinSignature;
  readonly score: number;
  readonly result: DuckDBType | undefined;
}
export function matchDuckDBBuiltin(
  catalog: DuckDBCatalog,
  name: string,
  args: readonly DuckDBType[],
  candidates: readonly DuckDBBuiltinSignature[] = catalog.builtinSignatures(name),
): readonly DuckDBBuiltinMatch[] {
  const matches: DuckDBBuiltinMatch[] = [];
  for (const signature of candidates) {
    if (args.length < signature[2].length || (!signature[4] && args.length !== signature[2].length)) continue;
    const bindings = new Map<string, DuckDBType>();
    let score = 0,
      valid = true;
    for (let i = 0; i < args.length; i++) {
      const source = i < signature[2].length ? signature[2][i] : signature[4];
      if (!source) {
        valid = false;
        break;
      }
      const matchScore = match(readPattern(source), args[i]!, bindings, catalog);
      if (matchScore === undefined) {
        valid = false;
        break;
      }
      score += matchScore;
    }
    if (valid)
      matches.push({
        signature,
        score,
        result: signature[3] ? resultType(readPattern(signature[3]), bindings) : undefined,
      });
  }
  return matches.sort((a, b) => a.score - b.score);
}
