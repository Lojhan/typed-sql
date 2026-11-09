import type { RuntimeValueType } from "@typed-sql/core";
import type { SchemaSnapshot } from "@typed-sql/schema";
import { postgresCodecTypeMapping } from "./codecs/index.js";
import { tokenize } from "./parser/tokenizer.js";
import type { PostgresTypePolicy } from "./policy.js";

function nameKey(source: string): string | undefined {
  try {
    const tokens = tokenize(source).filter((token) => token.kind !== "eof");
    if (tokens.length !== 1 && tokens.length !== 3) return undefined;
    const parts: string[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (index % 2) {
        if (token.text !== ".") return undefined;
      } else if (token.kind === "quoted-identifier") parts.push(token.value);
      else if (token.kind === "identifier" || token.kind === "keyword") parts.push(token.value.toLowerCase());
      else return undefined;
    }
    return JSON.stringify(parts);
  } catch {
    return undefined;
  }
}

/** Wire facts derive from declared enum labels, never by parsing a TypeScript union. */
export function postgresEnumRuntimeType(
  databaseType: string,
  schema: SchemaSnapshot,
  policy: PostgresTypePolicy,
): RuntimeValueType | undefined {
  let base = databaseType.trim(),
    dimensions = 0;
  while (base.endsWith("[]")) {
    dimensions++;
    base = base.slice(0, -2).trimEnd();
  }
  if (postgresCodecTypeMapping(base, schema) !== undefined) return undefined;
  const key = nameKey(base);
  const matches =
    schema.formatVersion === 2
      ? Object.values(schema.types).filter((type) => {
          if (type.identity === base) return true;
          const qualified = JSON.stringify(type.schema === undefined ? [type.name] : [type.schema, type.name]);
          const physical = nameKey(type.databaseType);
          return (
            key !== undefined && (qualified === key || (physical === key && JSON.parse(physical).at(-1) === type.name))
          );
        })
      : Object.entries(schema.enums ?? {})
          .filter(([name]) => key !== undefined && nameKey(name) === key)
          .map(([, labels]) => ({ kind: "enum", labels }));
  if (matches.length !== 1 || matches[0]!.kind !== "enum") return undefined;
  const labels = matches[0]!.labels;
  let type: RuntimeValueType =
    policy.enums === "string"
      ? "string"
      : labels.length === 0
        ? "never"
        : labels.length === 1
          ? { literal: labels[0]! }
          : { union: labels.map((literal) => ({ literal })) };
  while (dimensions-- > 0) type = { array: type, elementNullable: true };
  return type;
}
