import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { hash } from "../../model/canonical.mjs";
import { FunctionProfileSchema, validateFunctionProfile } from "./functions.mjs";
import { validateKeywordFacts } from "./keywords.mjs";

export const extractorId = "sqlite/vendor-catalog-v1";
export async function extractorRevision() {
  const files = ["facts.mjs", "keywords.mjs", "functions.mjs", "refresh.mjs", "extract-archive.py"];
  return hash(
    await Promise.all(files.map(async (path) => [path, await readFile(new URL(path, import.meta.url), "utf8")])),
  );
}
export const SQLiteSourceFactsSchema = Type.Object(
  {
    formatVersion: Type.Literal(1),
    grammar: Type.Literal("sqlite"),
    version: Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+$" }),
    revision: Type.String({ pattern: "^[a-f0-9]{40}$" }),
    defines: Type.Array(Type.String({ pattern: "^SQLITE_[A-Z0-9_]+(?:=\\d+)?$" }), { uniqueItems: true }),
    keywords: Type.Array(
      Type.Object(
        {
          name: Type.String({ pattern: "^[A-Z_]+$" }),
          token: Type.String({ pattern: "^TK_[A-Z_]+$" }),
          mask: Type.Integer({ minimum: 0 }),
          enabled: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    functionProfiles: Type.Array(FunctionProfileSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
const checker = TypeCompiler.Compile(SQLiteSourceFactsSchema);
/** @param {unknown} facts @returns {import('@sinclair/typebox').Static<typeof SQLiteSourceFactsSchema>} */
export function validateSourceFacts(facts) {
  if (!checker.Check(facts)) throw new TypeError("Invalid SQLite source facts");
  validateKeywordFacts(facts);
  if (!Array.isArray(facts.functionProfiles) || !facts.functionProfiles.length)
    throw new TypeError("Missing SQLite source function profiles");
  const ids = new Set();
  for (const profile of facts.functionProfiles) {
    validateFunctionProfile(profile);
    if (profile.version !== facts.version || ids.has(profile.id))
      throw new TypeError("Invalid SQLite function profile identity");
    ids.add(profile.id);
  }
  return facts;
}

/** Registration accounting only: binder ranges do not prove handler semantics or runtime types. */
export function functionCoverage(facts, policy) {
  const definitions = Object.values(policy.functions).flat();
  return Object.fromEntries(
    Object.entries(facts.versions).map(([version, value]) => {
      validateSourceFacts(value);
      return [
        version,
        Object.fromEntries(
          value.functionProfiles.map((profile) => {
            const names = new Set(profile.visible.map((row) => row.name.toUpperCase()));
            const policies = new Map(definitions.map((row) => [row.name, row]));
            const registrations = profile.registrations.map((row) => ({
              ...row,
              policy: policies.has(row.name.toUpperCase()) ? "declared; semantics not qualified" : "missing",
            }));
            return [
              profile.id,
              {
                configuration: "source build; separate from application/native wrapper qualification",
                defines: profile.defines,
                visibleNames: names.size,
                sourceOnly: [...names].filter((name) => !policies.has(name)).sort(),
                policyOnly: [...policies.keys()].filter((name) => !names.has(name)).sort(),
                registrations,
                connectionOnly: profile.visible.filter((row) => !row.builtin),
              },
            ];
          }),
        ),
      ];
    }),
  );
}
