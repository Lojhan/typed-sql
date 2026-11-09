import { duckDBAsciiFold, formatDuckDBType, parseDuckDBType } from "../native-types.js";
import type { DuckDBVocabulary } from "../vocabulary/types.js";
import type { Expression } from "./types.js";

/** Native display labels are versioned SQL syntax. Unproved forms require an explicit application alias. */
export function duckDBExpressionLabel(
  expression: Expression,
  version: string,
  vocabulary: DuckDBVocabulary,
  depth = 0,
): string | undefined {
  const ident = (name: string) =>
    /^[A-Za-z_][A-Za-z_0-9]*$/u.test(name) && vocabulary.lookup(name) === undefined
      ? name
      : `"${name.replaceAll('"', '""')}"`;
  if (depth > 128) return undefined;
  const label = (value: Expression | undefined) =>
    value ? duckDBExpressionLabel(value, version, vocabulary, depth + 1) : undefined;
  const args = (expression.args ?? []).map(label),
    all = args.every((value): value is string => value !== undefined);
  switch (expression.kind) {
    case "literal": {
      const value = expression.value ?? "NULL";
      if (value === "NULL") return "NULL";
      if (value === "TRUE" || value === "FALSE")
        return version === "1.5.6" ? `CAST('${value === "TRUE" ? "t" : "f"}' AS BOOLEAN)` : value.toLowerCase();
      if (value.startsWith('"')) return `'${(JSON.parse(value) as string).replaceAll("'", "''")}'`;
      if (version === "2.0.0" && expression.literalSource) return expression.literalSource;
      if (/^-?\d+$/u.test(value)) return BigInt(value).toString();
      if (/^-?\d*\.\d+$/u.test(value)) {
        const [whole, fraction] = value.split(".");
        const integer = BigInt(whole || "0");
        const minus = value.startsWith("-") && integer === 0n && /[1-9]/u.test(fraction!) ? "-" : "";
        return `${minus}${integer}.${fraction}`;
      }
      return undefined;
    }
    case "name": {
      if (expression.left) return undefined;
      return expression.names?.map(ident).join(".");
    }
    case "star":
      return expression.left ? `${label(expression.left)}.*` : "*";
    case "parameter":
      return `$${expression.value}`;
    case "cast": {
      const value = label(expression.left),
        type = parseDuckDBType(expression.nativeType!);
      if (!value || type.kind !== "scalar" || type.name === "TIMESTAMPTZ_NS") return undefined;
      let typeText = formatDuckDBType(type).replaceAll(",", ", ");
      if (version === "1.5.6") {
        if (type.name === "BIT") typeText = "BIT(1)";
        else if (type.name === "TIMESTAMPTZ") typeText = '"TIMESTAMP WITH TIME ZONE"';
        else if (type.name === "TIMETZ") typeText = '"TIME WITH TIME ZONE"';
        else if (
          ![
            "SMALLINT",
            "INTEGER",
            "BIGINT",
            "FLOAT",
            "VARCHAR",
            "BOOLEAN",
            "TIME",
            "TIMESTAMP",
            "INTERVAL",
            "DECIMAL",
          ].includes(type.name)
        )
          typeText = `"${typeText}"`;
      } else if (type.name === "JSON") typeText = '"JSON"';
      return `${expression.value === "TRY_CAST" ? "TRY_CAST" : "CAST"}(${value} AS ${typeText})`;
    }
    case "unary": {
      const value = label(expression.left);
      if (value === undefined || expression.value === "EXISTS") return undefined;
      return expression.value === "NOT"
        ? `(NOT ${value})`
        : version === "2.0.0"
          ? `(${expression.value}(${value}))`
          : `${expression.value}(${value})`;
    }
    case "binary": {
      const left = label(expression.left),
        right = label(expression.right);
      if (left === undefined || right === undefined || ["->", "->>"].includes(expression.value ?? "")) return undefined;
      return `(${left} ${expression.value} ${right})`;
    }
    case "list":
      return all ? `${version === "1.5.6" ? "main." : ""}list_value(${args.join(", ")})` : undefined;
    case "struct":
      return all
        ? `${version === "1.5.6" ? "main." : ""}struct_pack(${args.map((value, i) => `${ident(expression.names![i]!)} := ${value}`).join(", ")})`
        : undefined;
    case "tuple":
      return undefined;
    case "call": {
      if (!all || expression.window || expression.filter || expression.context?.length) return undefined;
      let name = duckDBAsciiFold(expression.names?.at(-1) ?? "");
      if (name === "count" && (!expression.args?.length || expression.args?.[0]?.kind === "star"))
        return "count_star()";
      if (["if", "ifnull", "nullif", "between", "not between", "in", "not in"].includes(name)) return undefined;
      name = name === "coalesce" ? "COALESCE" : ident(name);
      const prefix = (expression.names ?? []).slice(0, -1).map(ident);
      prefix.push(name);
      return `${prefix.join(".")}(${expression.distinct ? "DISTINCT " : ""}${args.map((value, i) => (expression.argumentNames?.[i] ? `${ident(expression.argumentNames[i]!)} := ${value}` : value)).join(", ")})`;
    }
    case "index": {
      const value = label(expression.left);
      return value !== undefined && all && args.length === 1 ? `${value}[${args[0]}]` : undefined;
    }
    default:
      return undefined;
  }
}
