import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { expandTarget, readCorpus } from "../../scripts/catalog-generation/corpus.mjs";
import { checkLockedFacts } from "../../tools/grammar-catalog/src/provenance/source-lock.mjs";
import { sourceCoverage } from "../../tools/grammar-catalog/src/sources/mysql/coverage.mjs";
import { extractorRevision, validateSourceFacts } from "../../tools/grammar-catalog/src/sources/mysql/facts.mjs";
import { functions, keywords } from "../../tools/grammar-catalog/src/sources/mysql/parse.mjs";

const lock = JSON.parse(await readFile(new URL("../../grammar/mysql/sources.lock.json", import.meta.url), "utf8"));
const facts = JSON.parse(await readFile(new URL("../../grammar/mysql/facts/catalog.json", import.meta.url), "utf8"));
await describe("locked MySQL registration and keyword facts", async () => {
  await it("covers all retained engine versions and compares every native keyword context", async () => {
    checkLockedFacts(lock, facts, validateSourceFacts);
    strict.equal(lock.extractor.revision, await extractorRevision());
    const corpus = await readCorpus();
    const contexts = Object.entries(corpus.targets)
      .filter(
        ([, target]) =>
          typeof target === "object" && target !== null && "dialect" in target && target.dialect === "mysql",
      )
      .map(([id, target]) => ({ id, capture: expandTarget(corpus, target) }));
    strict.deepEqual(
      Object.keys(facts.versions).sort(),
      [...new Set(contexts.map(({ capture }) => capture.target.version))].sort(),
    );
    const report = sourceCoverage(facts, [{ contexts }]);
    strict.equal(Object.keys(report.profiles).length, contexts.length);
    for (const { capture } of contexts) {
      const source = validateSourceFacts(facts.versions[capture.target.version]);
      strict.ok(source.functions.length > 300);
      strict.ok(source.functions.some(({ conditions }) => conditions.length > 0));
      strict.ok(source.functions.some(({ arityKnowledge }) => arityKnowledge === "specialized-unknown"));
      const concat = source.functions.find(({ name }) => name === "CONCAT")!;
      strict.equal(concat.minimum, 1);
      strict.equal(concat.maximum, null);
      strict.equal(concat.maximumExpression, "MAX_ARGLIST_SIZE");
      strict.equal(source.functions.find(({ name }) => name === "JSON_SET")?.parity, "odd");
      strict.ok(source.functions.some(({ internal }) => internal === true));
      strict.ok(source.licenseNotice.includes("GENERAL PUBLIC LICENSE"));
    }
    const first = contexts[0]!;
    strict.throws(
      () =>
        sourceCoverage(facts, [
          {
            contexts: [
              {
                ...first,
                capture: {
                  ...first.capture,
                  categories: {
                    ...first.capture.categories,
                    keywords: {
                      ...first.capture.categories.keywords,
                      rows: first.capture.categories.keywords.rows.slice(1),
                    },
                  },
                },
              },
            ],
          },
        ]),
      /keywords disagree/u,
    );
    const changed = structuredClone(facts);
    changed.versions[Object.keys(facts.versions)[0]!].functions[0].minimum = 999;
    strict.throws(() => checkLockedFacts(lock, changed, validateSourceFacts), /disagree/u);
  });

  await it("retains conditional registrations and qualifies multiline macro metadata", () => {
    const source =
      '#define SQL_FN(F, N) &Function_factory<Instantiator<F, N>>::s_singleton\n#define SQL_FN_ODD(F, MIN, MAX) \\\n &Odd_argcount_function_factory<List_instantiator_with_thd<F, MIN, MAX>>::s_singleton\nstatic const pair func_array[] = {\n{"FRESH", SQL_FN(New_class, 2)},\n#ifndef NDEBUG\n{"DEBUG_ONLY", SQL_FN_ODD(Debug_class, 1, MAX_ARGLIST_SIZE)},\n#endif\n{"SPECIAL", SQL_FACTORY(Custom_class)},\n};';
    const rows = functions(source);
    strict.equal(rows.length, 3);
    strict.equal(rows[0]!.minimum, 2);
    strict.equal(rows[0]!.maximum, 2);
    strict.equal(rows[1]!.parity, "odd");
    strict.deepEqual(rows[1]!.conditions, ["#ifndef NDEBUG"]);
    strict.equal(rows[2]!.minimum, null);
    strict.equal(rows[2]!.arityKnowledge, "specialized-unknown");
    strict.throws(() => functions(source.replace("#endif", "")), /Unclosed/u);
    strict.throws(() => functions(source.replace("MAX_ARGLIST_SIZE", "UNKNOWN_LIMIT")), /Unknown MySQL arity/u);
    strict.throws(() => functions(source.replace("#ifndef NDEBUG", "#unexpected directive")), /Unsupported/u);
    strict.equal(
      functions(source.replace("Function_factory<Instantiator", "Other_factory<Instantiator"))[0]!.arityKnowledge,
      "specialized-unknown",
    );
    strict.throws(
      () => functions(source.replace("#endif", "#else\n#else\n#endif")),
      /Duplicate MySQL source condition/u,
    );
  });

  await it("separates keyword reservation, operators and lexical function names without a name list", () => {
    const lex =
      'static const SYMBOL symbols[] = {{SYM("FRESH", FRESH_TOKEN)}, {SYM("FREE", FREE_TOKEN)}, {SYM_FN("CALLABLE", CALL_TOKEN)}, {SYM("&&", AND_TOKEN)}};';
    const yacc = "%token FRESH_TOKEN 1\n%token <lexer.keyword> FREE_TOKEN 2\n%token CALL_TOKEN 3\n%token AND_TOKEN 4";
    const facts = keywords(lex, yacc);
    strict.deepEqual(
      facts.keywords.map(({ name, reserved }) => ({ name, reserved })),
      [
        { name: "FRESH", reserved: true },
        { name: "FREE", reserved: false },
      ],
    );
    strict.deepEqual(
      facts.lexicalFunctions.map(({ name }) => name),
      ["CALLABLE"],
    );
    strict.equal(facts.symbols.length, 4);
    strict.throws(() => keywords(lex, yacc.replace("FRESH_TOKEN 1", "FRESH_TOKEN")), /token declaration/u);
    strict.throws(() => keywords(lex.replace("SYM_FN", "NEW_GROUP"), yacc), /lexical record/u);
  });
});
