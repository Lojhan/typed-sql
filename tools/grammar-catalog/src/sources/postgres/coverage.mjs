import { hash } from "../../model/canonical.mjs";
import { compareRoutines } from "./model.mjs";

const categoryCodes = Object.freeze({
  UNRESERVED_KEYWORD: "U",
  COL_NAME_KEYWORD: "C",
  TYPE_FUNC_NAME_KEYWORD: "T",
  RESERVED_KEYWORD: "R",
});
const sourceVersion = (version) => /^(\d+(?:\.\d+|beta\d+))(?:\s|$)/u.exec(version)?.[1];
const names = (rows, field) => [...new Set(rows.map((row) => row[field]))].sort();
function nameInventory(source, native) {
  const sourceNames = new Set(source),
    nativeNames = new Set(native);
  return {
    sourceNames: sourceNames.size,
    nativeNames: nativeNames.size,
    nativeOnlyNames: [...nativeNames].filter((name) => !sourceNames.has(name)).sort(),
    sourceOnlyNames: [...sourceNames].filter((name) => !nativeNames.has(name)).sort(),
    qualification: "name inventory only; overloads, runtime types, nullability and decoding unqualified",
  };
}

function profileCoverage(facts, capture, parserKeywords, prepared) {
  const version = sourceVersion(capture.target.version),
    source = facts.versions[version];
  if (!source) throw new TypeError(`Missing pinned PostgreSQL source version: ${capture.target.version}`);
  const nativeKeywords = capture.categories.keywords;
  if (nativeKeywords?.status !== "observed") throw new TypeError("PostgreSQL keyword inventory is unqualified");
  const expected = source.keywords
    .map((row) => {
      const category = categoryCodes[row.category];
      if (!category) throw new TypeError(`Unknown PostgreSQL keyword category: ${row.category}`);
      return [row.name, category];
    })
    .sort(([a], [b]) => a.localeCompare(b));
  const actual = nativeKeywords.rows
    .map(({ name, category }) => [name, category])
    .sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new TypeError(`PostgreSQL source/native keyword inventories differ: ${version}`);
  const routines = source.catalogs.pg_proc.entries.map(({ row }) => facts.rows[row]);
  const types = source.catalogs.pg_type.entries.map(({ row }) => facts.rows[row]);
  const nativeRoutines = capture.categories.functions,
    nativeTypes = capture.categories.types;
  if (nativeRoutines?.status !== "observed" || nativeTypes?.status !== "observed")
    throw new TypeError("PostgreSQL routine/type inventory is unqualified");
  const parser = new Set(parserKeywords.map((name) => name.toLowerCase()));
  const comparison = prepared?.comparison ?? compareRoutines(facts, source, capture);
  return {
    version,
    sourceRevision: source.revision,
    keywords: {
      source: expected.length,
      native: actual.length,
      comparison: "exact names and categories",
      recognizedParserWords: source.keywords.filter(({ name }) => parser.has(name)).map(({ name }) => name),
      otherNativeWords: source.keywords.filter(({ name }) => !parser.has(name)).map(({ name }) => name),
      parserWordsOutsideNativeKeywordList: [...parser]
        .filter((name) => !source.keywords.some((row) => row.name === name))
        .sort(),
    },
    procedures: {
      scope: "bootstrap data rows only; installation routines are accounted for under routineDescriptors",
      sourceRegistrations: routines.length,
      nativeRegistrations: nativeRoutines.rows.length,
      ...nameInventory(names(routines, "proname"), names(nativeRoutines.rows, "name")),
    },
    routineDescriptors: {
      scope: comparison.qualification,
      matched: comparison.matched.length,
      matchedPairsDigest: hash(comparison.matched),
      installationHeaders: comparison.installationHeaders,
      installedRoutineDeclarations: comparison.installedRoutineDeclarations,
      installationGaps: comparison.installationGaps,
      sourceOnly: comparison.sourceOnly,
      nativeOnly: comparison.nativeOnly,
      mismatches: comparison.mismatches,
    },
    types: {
      sourceRegistrations: types.length,
      nativeRegistrations: nativeTypes.rows.length,
      ...nameInventory(names(types, "typname"), names(nativeTypes.rows, "name")),
    },
    uninterpretedInputs: source.uninterpretedInputs,
  };
}

/** Compare independent captured inventories without importing a generated parser or grammar. */
export function sourceCoverage(facts, groups, parserKeywords, prepared = new Map()) {
  /** @type {Record<string, ReturnType<typeof profileCoverage>>} */
  const profiles = {};
  for (const group of groups)
    for (const { id, capture } of group.contexts)
      profiles[id] = profileCoverage(facts, capture, parserKeywords, prepared.get(id));

  return {
    formatVersion: 1,
    grammar: "postgres",
    scope:
      "Bootstrap catalog data and keyword declarations; SQL installation scripts, parser productions, platform configuration, extension availability and live semantic qualification remain incomplete",
    profiles,
  };
}
