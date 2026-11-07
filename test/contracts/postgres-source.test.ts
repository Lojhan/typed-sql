import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { expandTarget, readCorpus } from "../../scripts/catalog-generation/corpus.mjs";
import { hash } from "../../tools/grammar-catalog/src/model/canonical.mjs";
import { checkLockedFacts } from "../../tools/grammar-catalog/src/provenance/source-lock.mjs";
import { sourceCoverage } from "../../tools/grammar-catalog/src/sources/postgres/coverage.mjs";
import {
  parseKeywords,
  readLockedSources,
  validateSourceFacts,
  validateSourceVersion,
} from "../../tools/grammar-catalog/src/sources/postgres/facts.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { lock, facts } = await readLockedSources(root);
const corpus = await readCorpus();
const captures = Object.entries(corpus.targets)
  .filter(
    ([, target]) =>
      typeof target === "object" && target !== null && "dialect" in target && target.dialect === "postgres",
  )
  .map(([id, target]) => ({ id, capture: expandTarget(corpus, target) }));
const groups = [{ contexts: captures }];
const policy = JSON.parse(
  await readFile(new URL("../../grammar/postgres/catalog/policy.json", import.meta.url), "utf8"),
);

await describe("locked PostgreSQL bootstrap source facts", async () => {
  await it("covers every retained exact engine version without requiring vendor tools during generation", () => {
    const versions = [
      ...new Set(captures.map(({ capture }) => /^(\d+(?:\.\d+|beta\d+))/u.exec(capture.target.version)![1])),
    ].sort();
    strict.deepEqual(Object.keys(facts.versions).sort(), versions);
    strict.deepEqual(
      lock.sources.map(({ version }: { version: string }) => version),
      versions,
    );
    for (const source of lock.sources) {
      strict.ok(source.files["source.tar.gz"]);
      strict.equal(source.license.identifier, "PostgreSQL");
      const version = facts.versions[source.version]!;
      strict.ok(Object.keys(version.catalogs).length > 20);
      strict.ok(version.uninterpretedInputs.includes("src/backend/parser/gram.y"));
      strict.ok(version.uninterpretedInputs.includes("src/backend/catalog/system_functions.sql"));
      const rows = version.catalogs.pg_proc!.entries.map(({ row }) => facts.rows[row]!);
      strict.ok(rows.length > 3000);
      const concat = rows.find(({ proname }) => proname === "concat")!;
      strict.equal(concat.proargtypes, "any");
      strict.equal(concat.proargmodes, "{v}");
      strict.equal(concat.provariadic, "any");
      strict.equal(concat.proisstrict, "f");
      strict.equal(concat.prorettype, "text");
      strict.equal(version.keywords.find(({ name }) => name === "select")?.category, "RESERVED_KEYWORD");
    }
  });

  await it("matches independent native keyword names and categories and retains narrower coverage limits", () => {
    const coverage = sourceCoverage(facts, groups, policy.parser.keywords);
    strict.equal(Object.keys(coverage.profiles).length, captures.length);
    for (const profile of Object.values(coverage.profiles)) {
      strict.equal(profile.keywords.source, profile.keywords.native);
      strict.equal(
        profile.keywords.recognizedParserWords.length + profile.keywords.otherNativeWords.length,
        profile.keywords.source,
      );
      strict.ok(profile.procedures.nativeOnlyNames.length > 0, "SQL-installed functions remain explicit gaps");
      strict.match(profile.procedures.qualification, /name inventory only/u);
      strict.ok(profile.types.nativeOnlyNames.length > 0, "initdb-created composite types are not bootstrap dat rows");
    }
    const first = captures[0]!;
    const keywords = first.capture.categories.keywords;
    const broken = [
      {
        contexts: [
          {
            ...first,
            capture: {
              ...first.capture,
              categories: { ...first.capture.categories, keywords: { ...keywords, rows: keywords.rows.slice(1) } },
            },
          },
        ],
      },
    ];
    strict.throws(() => sourceCoverage(facts, broken, policy.parser.keywords), /keyword inventories differ/u);
  });

  await it("rejects digest corruption, missing closure members, orphaned rows and version loss", () => {
    const id = Object.keys(facts.rows)[0]!;
    strict.throws(
      () => validateSourceFacts({ ...facts, rows: { ...facts.rows, [id]: { ...facts.rows[id], forged: "value" } } }),
      /row digest differs/u,
    );
    const { [id]: _removed, ...missing } = facts.rows;
    strict.throws(() => validateSourceFacts({ ...facts, rows: missing }), /Missing or duplicate/u);
    const unused = { name: "unused" };
    strict.throws(
      () => validateSourceFacts({ ...facts, rows: { ...facts.rows, [hash(unused)]: unused } }),
      /Orphaned/u,
    );
    const version = Object.keys(facts.versions)[0]!;
    const { [version]: _removedVersion, ...versions } = facts.versions;
    strict.throws(() => checkLockedFacts(lock, { ...facts, versions }, validateSourceVersion), /version coverage/u);
    const changed = structuredClone(facts.versions[version]!);
    changed.revision = "0".repeat(40);
    strict.throws(
      () =>
        checkLockedFacts(
          lock,
          { ...facts, versions: { ...facts.versions, [version]: changed } },
          validateSourceVersion,
        ),
      /disagree/u,
    );
  });

  await it("parses keyword declarations including vendor comments without skipping unfamiliar records", () => {
    const declaration = 'PG_KEYWORD("analyse", ANALYSE, RESERVED_KEYWORD, BARE_LABEL) /* British spelling */';
    strict.deepEqual(parseKeywords(declaration), [
      { name: "analyse", token: "ANALYSE", category: "RESERVED_KEYWORD", label: "BARE_LABEL" },
    ]);
    strict.throws(() => parseKeywords("/* no declarations */"), /Missing/u);
    strict.throws(() => parseKeywords('PG_KEYWORD("new", NEW, UNKNOWN, BARE_LABEL, NEW_FIELD)'), /Unsupported/u);
    strict.throws(() => parseKeywords(`${declaration}\n${declaration}`), /Duplicate/u);
  });
});
