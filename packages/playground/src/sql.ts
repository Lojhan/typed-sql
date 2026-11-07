import { compileSqlFile } from "@typed-sql/compiler";
import type { DialectPlugin, SchemaSnapshot } from "@typed-sql/core";
import { WorkspaceError } from "./files.js";
import { decodeValue, type WireValue } from "./values.js";

/** Binding identities come from the grammar's lexer, never a SQL regular expression. */
export function analyzeSql(source: string, dialect: DialectPlugin, schema: SchemaSnapshot, typePolicy: unknown) {
  const compiled = compileSqlFile({ source, dialect, schema, typePolicy });
  const occurrences = compiled.query ? (dialect.parameterOccurrences?.(source, schema, typePolicy) ?? []) : [];
  const identities: string[] = [];
  const bindings = occurrences.map((occurrence) => {
    const identity = occurrence.name === undefined ? `$${occurrence.index}` : occurrence.name;
    if (!identities.includes(identity)) identities.push(identity);
    return identities.indexOf(identity);
  });
  // Positional inputs retain numeric index order even when their first lexical occurrence is reversed.
  if (occurrences.length && occurrences.every((occurrence) => occurrence.name === undefined)) {
    identities.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    for (const [index, occurrence] of occurrences.entries()) bindings[index] = occurrence.index - 1;
  }
  const parameters = identities.map((name, index) => ({
    ...compiled.query?.variants[0]?.parameters.find((parameter) => parameter.index === bindings.indexOf(index) + 1),
    index: index + 1,
    name,
  }));
  return { compiled, bindings, identities, parameters };
}

export function bindSql(analysis: ReturnType<typeof analyzeSql>, values: readonly WireValue[]): readonly WireValue[] {
  if (!analysis.compiled.query)
    throw new WorkspaceError("SQL_CHECK", "SQL analysis did not produce an executable statement");
  if (values.length !== analysis.identities.length)
    throw new WorkspaceError("BINDINGS", `Expected ${analysis.identities.length} distinct parameter values`);
  for (const [index, encoded] of values.entries()) {
    const parameter = analysis.parameters[index];
    const value = decodeValue(encoded);
    if (value === null) {
      if (parameter?.nullable !== true)
        throw new WorkspaceError("BINDINGS", `Parameter ${index + 1} does not accept NULL`);
      continue;
    }
    const type = parameter?.tsType;
    const accepted =
      type === "number"
        ? typeof value === "number" && Number.isFinite(value)
        : type === "bigint"
          ? typeof value === "bigint"
          : type === "boolean"
            ? typeof value === "boolean"
            : type === "string"
              ? typeof value === "string"
              : type === "Date"
                ? value instanceof Date && Number.isFinite(value.getTime())
                : type === "Uint8Array"
                  ? value instanceof Uint8Array
                  : false;
    if (!accepted)
      throw new WorkspaceError(
        "BINDINGS",
        `Parameter ${index + 1} requires ${type ?? "a supported scalar type"}. Use a TypeScript query file for structured/custom parameter codecs.`,
      );
  }
  return analysis.bindings.map((index) => values[index]!);
}
