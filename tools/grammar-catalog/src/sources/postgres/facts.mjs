import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { hash } from "../../model/canonical.mjs";
import { assertJson } from "../../model/json.mjs";
import { checkLockedFacts, parseSourceLock } from "../../provenance/source-lock.mjs";

/** @template {import('@sinclair/typebox').TProperties} T @param {T} properties */
const object = (properties) => Type.Object(properties, { additionalProperties: false });
const digest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const text = Type.String({ minLength: 1 });
export const PostgresSourceVersionSchema = object({
  version: Type.String({ pattern: "^\\d+(?:\\.\\d+|beta\\d+)$" }),
  revision: Type.String({ pattern: "^[a-f0-9]{40}$" }),
  defines: Type.Array(text, { maxItems: 0 }),
  catalogs: Type.Record(
    Type.String({ pattern: "^pg_[a-z0-9_]+$" }),
    object({
      schema: digest,
      entries: Type.Array(object({ row: digest, line: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]) })),
    }),
    { minProperties: 1 },
  ),
  keywords: Type.Array(object({ name: text, token: text, category: text, label: text }), { minItems: 1 }),
  uninterpretedInputs: Type.Array(text, { uniqueItems: true }),
});
export const PostgresSourceFactsSchema = object({
  formatVersion: Type.Literal(1),
  grammar: Type.Literal("postgres"),
  // Vendor schema and rows are retained JSON, not interpreted semantic claims.
  schemas: Type.Record(
    digest,
    Type.Object(
      {
        catname: text,
        columns: Type.Array(Type.Object({ name: text, type: text }, { additionalProperties: true }), { minItems: 1 }),
      },
      { additionalProperties: true },
    ),
  ),
  rows: Type.Record(digest, Type.Record(Type.String(), Type.Union([Type.String(), Type.Integer()]))),
  versions: Type.Record(text, PostgresSourceVersionSchema, { minProperties: 1 }),
});
const checker = TypeCompiler.Compile(PostgresSourceFactsSchema);
const versionChecker = TypeCompiler.Compile(PostgresSourceVersionSchema);
export const extractorId = "postgres/vendor-bootstrap-v1";
export async function extractorRevision() {
  return hash(
    await Promise.all(
      ["facts.mjs", "refresh.mjs", "extract.pl", "extract-archive.py"].map(async (path) => [
        path,
        await readFile(new URL(path, import.meta.url), "utf8"),
      ]),
    ),
  );
}

export function parseKeywords(body) {
  const declarations = body
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split(/\r?\n/u)
    .filter((line) => /^\s*PG_KEYWORD\b/u.test(line));
  if (!declarations.length) throw new TypeError("Missing PostgreSQL keyword declarations");
  const keywords = declarations.map((line) => {
    const match = /^\s*PG_KEYWORD\("([a-z_]+)",\s*([A-Z_0-9]+),\s*([A-Z_]+),\s*([A-Z_]+)\)\s*$/u.exec(line);
    if (!match) throw new TypeError("Unsupported PostgreSQL keyword declaration");
    return { name: match[1], token: match[2], category: match[3], label: match[4] };
  });
  if (new Set(keywords.map(({ name }) => name)).size !== keywords.length)
    throw new TypeError("Duplicate PostgreSQL source keyword");
  return keywords;
}

/** Factor source locations out of row identity while retaining every vendor field. */
export function addCatalogFacts(envelope, { version, revision, catalogs, keywords, uninterpretedInputs }) {
  const fact = { version, revision, defines: [], catalogs: {}, keywords, uninterpretedInputs };
  for (const [name, value] of Object.entries(catalogs)) {
    const schema = hash(value.schema);
    envelope.schemas[schema] = value.schema;
    fact.catalogs[name] = {
      schema,
      entries: value.rows.map((value) => {
        const { line_number: line = null, ...row } = value;
        const id = hash(row);
        envelope.rows[id] = row;
        return { row: id, line };
      }),
    };
  }
  envelope.versions[version] = fact;
  return fact;
}

/** @param {unknown} value @returns {import('@sinclair/typebox').Static<typeof PostgresSourceVersionSchema>} */
export function validateSourceVersion(value) {
  if (!versionChecker.Check(value)) throw new TypeError("Invalid PostgreSQL source version facts");
  const names = value.keywords.map(({ name }) => name);
  if (new Set(names).size !== names.length) throw new TypeError("Duplicate PostgreSQL keyword facts");
  return value;
}

/** Validate retained raw facts and their complete content-addressed closure.
 * @param {unknown} value
 * @returns {import('@sinclair/typebox').Static<typeof PostgresSourceFactsSchema>}
 */
export function validateSourceFacts(value) {
  assertJson(value);
  if (!checker.Check(value)) throw new TypeError("Invalid PostgreSQL source facts");
  for (const [id, schema] of Object.entries(value.schemas))
    if (hash(schema) !== id) throw new TypeError("PostgreSQL catalog schema digest differs");
  for (const [id, row] of Object.entries(value.rows))
    if (hash(row) !== id) throw new TypeError("PostgreSQL catalog row digest differs");
  const usedSchemas = new Set(),
    usedRows = new Set();
  for (const [version, fact] of Object.entries(value.versions)) {
    validateSourceVersion(fact);
    if (version !== fact.version) throw new TypeError("PostgreSQL source version identity differs");
    for (const [name, catalog] of Object.entries(fact.catalogs)) {
      const schema = value.schemas[catalog.schema];
      if (schema?.catname !== name || !Array.isArray(schema.columns) || !schema.columns.length)
        throw new TypeError("Missing PostgreSQL catalog schema");
      usedSchemas.add(catalog.schema);
      const rows = new Set();
      for (const entry of catalog.entries) {
        const row = value.rows[entry.row];
        if (!row || rows.has(entry.row)) throw new TypeError("Missing or duplicate PostgreSQL catalog row");
        rows.add(entry.row);
        usedRows.add(entry.row);
        for (const column of schema.columns)
          if (column.name !== "oid" && !Object.hasOwn(row, column.name))
            throw new TypeError(`Missing PostgreSQL catalog field: ${name}.${column.name}`);
      }
    }
  }
  if (usedSchemas.size !== Object.keys(value.schemas).length || usedRows.size !== Object.keys(value.rows).length)
    throw new TypeError("Orphaned PostgreSQL source facts");
  return value;
}

export async function readLockedSources(root) {
  const { join } = await import("node:path");
  const [lock, facts] = await Promise.all([
    readFile(join(root, "grammar/postgres/sources.lock.json"), "utf8").then(JSON.parse),
    readFile(join(root, "grammar/postgres/facts/catalog.json"), "utf8").then(JSON.parse),
  ]);
  validateSourceFacts(facts);
  checkLockedFacts(lock, facts, validateSourceVersion);
  if (lock.extractor.id !== extractorId || lock.extractor.revision !== (await extractorRevision()))
    throw new TypeError("PostgreSQL source extractor revision differs");
  return { lock: parseSourceLock(lock), facts: validateSourceFacts(facts) };
}
