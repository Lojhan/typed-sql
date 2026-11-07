import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { hash } from "../../model/canonical.mjs";
import { assertJson } from "../../model/json.mjs";

/** @template {import('@sinclair/typebox').TProperties} T @param {T} properties */
const object = (properties) => Type.Object(properties, { additionalProperties: false });
const text = Type.String({ minLength: 1 });
const nullableText = Type.Union([text, Type.Null()]);
export const DuckDBRegistrationSchema = object({
  schema: text,
  name: text,
  kind: Type.Union(
    ["scalar", "aggregate", "window", "table", "pragma", "macro", "table_macro"].map((value) => Type.Literal(value)),
  ),
  overload: Type.Integer({ minimum: 0 }),
  result: nullableText,
  definition: nullableText,
  macroDefaults: Type.Array(object({ name: text, expression: text })),
  parameters: Type.Union([
    Type.Null(),
    Type.Array(
      object({
        name: nullableText,
        type: nullableText,
        kind: Type.Union([Type.Null(), Type.Integer({ minimum: 0, maximum: 4 })]),
        default: nullableText,
      }),
    ),
  ]),
  options: Type.Array(object({ name: text, type: text, aliases: Type.Array(text, { uniqueItems: true }) })),
});
export const DuckDBSourceFactsSchema = object({
  formatVersion: Type.Literal(1),
  grammar: Type.Literal("duckdb"),
  version: Type.String({ pattern: "^[12]\\.\\d+\\.\\d+$" }),
  signatureApi: Type.Union([Type.Literal(1), Type.Literal(2)]),
  revision: Type.String({ pattern: "^[a-f0-9]{40}$" }),
  sourceId: Type.String({ pattern: "^[a-f0-9]{10,40}$" }),
  profile: text,
  defines: Type.Array(text, { uniqueItems: true }),
  registrations: Type.Array(DuckDBRegistrationSchema, { minItems: 1 }),
});
const checker = TypeCompiler.Compile(DuckDBSourceFactsSchema);
const registrationChecker = TypeCompiler.Compile(DuckDBRegistrationSchema);
export const extractorId = "duckdb/vendor-signatures-v1";
export async function extractorRevision() {
  return hash(
    await Promise.all(
      ["facts.mjs", "refresh.mjs", "extract-v1.cpp", "extract-v2.cpp", "extract-archive.py"].map(async (path) => [
        path,
        await readFile(new URL(path, import.meta.url), "utf8"),
      ]),
    ),
  );
}
export const registrationKey = (row) => JSON.stringify([row.schema, row.name, row.kind, row.overload]);
const compareRegistrations = (a, b) => {
  const left = registrationKey(a),
    right = registrationKey(b);
  return left < right ? -1 : left > right ? 1 : 0;
};
/** @param {unknown} value @returns {import('@sinclair/typebox').Static<typeof DuckDBSourceFactsSchema>} */
export function validateSourceFacts(value) {
  assertJson(value);
  if (!checker.Check(value)) throw new TypeError("Invalid DuckDB source facts");
  if (Number(value.version.split(".")[0]) !== value.signatureApi)
    throw new TypeError("DuckDB signature API/version differs");
  if (!value.revision.startsWith(value.sourceId)) throw new TypeError("DuckDB library/source revision differs");
  const keys = new Set();
  const overloads = new Map();
  for (const row of value.registrations) {
    const key = registrationKey(row);
    if (keys.has(key)) throw new TypeError("Duplicate DuckDB registration");
    keys.add(key);
    const groupKey = JSON.stringify([row.schema, row.name, row.kind]);
    const group = overloads.get(groupKey) ?? [];
    group.push(row.overload);
    overloads.set(groupKey, group);
    const names = new Set();
    let previous = -1;
    if (
      value.signatureApi === 2 &&
      (row.parameters === null ||
        row.parameters.some((parameter) => parameter.name === null || parameter.kind === null))
    )
      throw new TypeError("Incomplete DuckDB v2 signature");
    for (const parameter of row.parameters ?? []) {
      const folded = parameter.name?.replace(/[A-Z]/gu, (c) => c.toLowerCase());
      if (
        (folded !== undefined && names.has(folded)) ||
        (parameter.kind !== null && parameter.kind < previous) ||
        ((parameter.kind === 2 || parameter.kind === 4) && parameter.default !== null)
      )
        throw new TypeError("Invalid DuckDB parameter sequence");
      if (folded !== undefined) names.add(folded);
      if (parameter.kind !== null) previous = parameter.kind;
    }
    const options = new Set();
    for (const option of row.options)
      for (const name of [option.name, ...option.aliases]) {
        const folded = name.replace(/[A-Z]/gu, (c) => c.toLowerCase());
        if (options.has(folded)) throw new TypeError("Duplicate DuckDB option name");
        options.add(folded);
      }
  }
  for (const group of overloads.values())
    if (group.sort((a, b) => a - b).some((value, index) => value !== index))
      throw new TypeError("Noncontiguous DuckDB overload ordinals");
  if (hash([...value.registrations].sort(compareRegistrations)) !== hash(value.registrations))
    throw new TypeError("Noncanonical DuckDB registration order");
  return value;
}
export function parseSignatureOutput(output, { version, revision, profile, signatureApi = 2 }) {
  const lines = output.trimEnd().split("\n");
  const header = JSON.parse(lines.shift());
  if (
    Object.keys(header).sort().join(",") !== "sourceId,version" ||
    header.version !== `v${version}` ||
    typeof header.sourceId !== "string" ||
    !revision.startsWith(header.sourceId)
  )
    throw new TypeError("DuckDB extractor engine identity differs");
  const footer = JSON.parse(lines.pop());
  if (
    Object.keys(footer).join(",") !== "registrations" ||
    !Number.isSafeInteger(footer.registrations) ||
    footer.registrations !== lines.length
  )
    throw new TypeError("Incomplete DuckDB registration output");
  const registrations = lines
    .map((line) => {
      const row = JSON.parse(line);
      if (!registrationChecker.Check(row)) throw new TypeError("Invalid DuckDB registration frame");
      return row;
    })
    .sort(compareRegistrations);
  return validateSourceFacts({
    formatVersion: 1,
    grammar: "duckdb",
    version,
    signatureApi,
    revision,
    profile,
    sourceId: header.sourceId,
    defines: [],
    registrations,
  });
}
