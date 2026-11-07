import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { hash } from "../../model/canonical.mjs";
import { assertJson } from "../../model/json.mjs";

/** @template {import('@sinclair/typebox').TProperties} T @param {T} properties */
const object = (properties) => Type.Object(properties, { additionalProperties: false });
const text = Type.String({ minLength: 1 }),
  count = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);
const symbol = object({ name: text, token: text, group: text, line: Type.Integer({ minimum: 1 }) });
export const MySQLSourceFactsSchema = object({
  version: Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+$" }),
  revision: Type.String({ pattern: "^[a-f0-9]{40}$" }),
  defines: Type.Array(text, { maxItems: 0 }),
  licenseNotice: text,
  keywords: Type.Array(
    object({ name: text, token: text, code: Type.Integer({ minimum: 0 }), reserved: Type.Boolean() }),
    { minItems: 1 },
  ),
  lexicalFunctions: Type.Array(object({ name: text, token: text, code: Type.Integer({ minimum: 0 }) })),
  symbols: Type.Array(symbol, { minItems: 1 }),
  functions: Type.Array(
    object({
      name: text,
      builder: text,
      conditions: Type.Array(text),
      line: Type.Integer({ minimum: 1 }),
      minimum: count,
      maximum: count,
      maximumExpression: Type.Union([text, Type.Null()]),
      parity: Type.Union(["any", "odd", "even", "unknown"].map((value) => Type.Literal(value))),
      internal: Type.Union([Type.Boolean(), Type.Null()]),
      arityKnowledge: Type.Union(["macro", "instantiator", "specialized-unknown"].map((value) => Type.Literal(value))),
      arityEvidence: Type.Array(object({ symbol: text, line: Type.Integer({ minimum: 1 }) })),
    }),
    { minItems: 1 },
  ),
});
const checker = TypeCompiler.Compile(MySQLSourceFactsSchema);
export const extractorId = "mysql/vendor-registration-v1";
export async function extractorRevision() {
  return hash(
    await Promise.all(
      ["facts.mjs", "parse.mjs", "instantiators.mjs", "refresh.mjs", "extract-archive.py"].map(async (path) => [
        path,
        await readFile(new URL(path, import.meta.url), "utf8"),
      ]),
    ),
  );
}
/** @param {unknown} value @returns {import('@sinclair/typebox').Static<typeof MySQLSourceFactsSchema>} */
export function validateSourceFacts(value) {
  assertJson(value);
  if (!checker.Check(value)) throw new TypeError("Invalid MySQL source facts");
  for (const key of ["keywords", "functions", "lexicalFunctions"])
    if (new Set(value[key].map(({ name }) => name)).size !== value[key].length)
      throw new TypeError(`Duplicate MySQL source ${key}`);
  for (const row of value.functions) {
    if ([row.minimum, row.maximum].some((count) => count !== null && !Number.isSafeInteger(count)))
      throw new TypeError("Unsafe MySQL source arity");
    if (row.minimum !== null && row.maximum !== null && row.maximum < row.minimum)
      throw new TypeError("Invalid MySQL source arity");
    if (
      row.arityKnowledge !== "specialized-unknown" &&
      (row.minimum === null || row.parity === "unknown" || row.internal === null)
    )
      throw new TypeError("Incomplete MySQL macro arity");
    if ((row.arityKnowledge === "instantiator") !== row.arityEvidence.length > 0)
      throw new TypeError("Inconsistent MySQL arity evidence");
  }
  return value;
}
