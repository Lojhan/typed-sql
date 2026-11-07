import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { hash } from "../../model/canonical.mjs";
import { assertJson } from "../../model/json.mjs";

/** @template {import('@sinclair/typebox').TProperties} T @param {T} properties */
const object = (properties) => Type.Object(properties, { additionalProperties: false });
const text = Type.String({ minLength: 1 }),
  offset = Type.Integer({ minimum: 0 }),
  line = Type.Integer({ minimum: 1 }),
  section = Type.Union([Type.Literal("parser"), Type.Literal("lexer")]),
  span = { start: offset, end: offset, line },
  nullableText = Type.Union([text, Type.Null()]);
const unit = object({
  path: text,
  offsetEncoding: Type.Literal("utf16"),
  text,
  digest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  classes: Type.Array(object({ name: text, section, line }), { minItems: 1 }),
  symbols: Type.Array(object({ symbol: text, literal: nullableText, line })),
  productions: Type.Array(
    object({
      name: text,
      section,
      visibility: Type.Union(["default", "protected", "public", "private"].map((value) => Type.Literal(value))),
      ...span,
      bodyStart: offset,
      bodyEnd: offset,
      literal: nullableText,
      handlers: Type.Array(object(span)),
    }),
    { minItems: 1 },
  ),
});
export const SQLServerSourceFactsSchema = object({
  version: Type.String({ pattern: "^[1-9][0-9]{2}$" }),
  revision: Type.String({ pattern: "^[a-f0-9]{40}$" }),
  defines: Type.Array(text, { maxItems: 0 }),
  scope: Type.Literal("ScriptDOM parser source; engine binding and semantic qualification are separate"),
  licenseNotice: text,
  common: unit,
  grammar: unit,
  targets: Type.Array(object({ id: text, version: text, compatibilityLevel: Type.Integer({ minimum: 1 }) }), {
    minItems: 1,
  }),
});
const checker = TypeCompiler.Compile(SQLServerSourceFactsSchema);
export const extractorId = "sqlserver/scriptdom-grammar-v1";
export const bytesDigest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export async function extractorRevision() {
  return hash(
    await Promise.all(
      ["facts.mjs", "grammar.mjs", "refresh.mjs", "extract-archive.py"].map(async (path) => [
        path,
        await readFile(new URL(path, import.meta.url), "utf8"),
      ]),
    ),
  );
}

export function keywordInventory(facts) {
  const symbols = new Map();
  for (const [owner, unit] of [
    ["common", facts.common],
    ["version", facts.grammar],
  ])
    for (const row of unit.symbols) {
      const previous = symbols.get(row.symbol);
      if (previous?.literal && row.literal && previous.literal !== row.literal)
        throw new TypeError("Conflicting ScriptDOM token spelling");
      if (row.literal !== null) symbols.set(row.symbol, { ...row, owner });
    }
  const words = [...symbols.values()].filter(({ literal }) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(literal));
  if (new Set(words.map(({ literal }) => literal)).size !== words.length)
    throw new TypeError("Duplicate ScriptDOM keyword spelling");
  return words.sort((a, b) => a.literal.localeCompare(b.literal));
}

/** @param {unknown} value @returns {import('@sinclair/typebox').Static<typeof SQLServerSourceFactsSchema>} */
export function validateSourceFacts(value) {
  assertJson(value);
  if (!checker.Check(value)) throw new TypeError("Invalid SQL Server parser source facts");
  const expected = [`TSql${value.version}ParserInternal`, `TSql${value.version}LexerInternal`];
  if (JSON.stringify(value.grammar.classes.map(({ name }) => name)) !== JSON.stringify(expected))
    throw new TypeError("ScriptDOM parser profile/class differs");
  if (value.common.classes.length !== 1 || value.common.classes[0].name !== "TSql")
    throw new TypeError("Invalid ScriptDOM common vocabulary class");
  for (const unit of [value.common, value.grammar]) {
    if (bytesDigest(Buffer.from(unit.text, "utf8")) !== unit.digest)
      throw new TypeError("ScriptDOM source text digest differs");
    if (
      new Set(unit.productions.map(({ section, name }) => `${section}/${name}`)).size !== unit.productions.length ||
      new Set(unit.symbols.map(({ symbol }) => symbol)).size !== unit.symbols.length
    )
      throw new TypeError("Duplicate ScriptDOM source declaration");
    let previousEnd = 0;
    for (const row of unit.productions) {
      if (
        ![row.start, row.end, row.bodyStart, row.bodyEnd].every(Number.isSafeInteger) ||
        row.start < previousEnd ||
        row.start >= row.bodyStart ||
        row.bodyStart > row.bodyEnd ||
        row.bodyEnd >= row.end ||
        row.end > unit.text.length
      )
        throw new TypeError("Invalid ScriptDOM production span");
      previousEnd = row.end;
      let handlerEnd = row.bodyEnd;
      for (const handler of row.handlers) {
        if (handler.start <= handlerEnd || handler.start >= handler.end || handler.end > row.end)
          throw new TypeError("Invalid ScriptDOM exception span");
        handlerEnd = handler.end;
      }
    }
  }
  if (
    new Set(value.targets.map(({ id }) => id)).size !== value.targets.length ||
    value.targets.some(({ compatibilityLevel }) => compatibilityLevel !== Number(value.version))
  )
    throw new TypeError("ScriptDOM/native compatibility profile differs");
  keywordInventory(value);
  return value;
}
