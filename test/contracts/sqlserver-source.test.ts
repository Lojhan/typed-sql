import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { expandTarget, readCorpus } from "../../scripts/catalog-generation/corpus.mjs";
import { checkLockedFacts } from "../../tools/grammar-catalog/src/provenance/source-lock.mjs";
import { sourceCoverage } from "../../tools/grammar-catalog/src/sources/sqlserver/coverage.mjs";
import {
  extractorRevision,
  keywordInventory,
  validateSourceFacts,
} from "../../tools/grammar-catalog/src/sources/sqlserver/facts.mjs";
import { parseGrammar } from "../../tools/grammar-catalog/src/sources/sqlserver/grammar.mjs";

await describe("locked ScriptDOM parser sources", async () => {
  await it("retains every production and associates each native compatibility context explicitly", async () => {
    const lock = JSON.parse(
        await readFile(new URL("../../grammar/sqlserver/sources.lock.json", import.meta.url), "utf8"),
      ),
      facts = JSON.parse(
        await readFile(new URL("../../grammar/sqlserver/facts/catalog.json", import.meta.url), "utf8"),
      );
    checkLockedFacts(lock, facts, validateSourceFacts);
    strict.equal(lock.extractor.revision, await extractorRevision());
    const corpus = await readCorpus(),
      contexts = Object.entries(corpus.targets)
        .filter(
          ([, target]) =>
            typeof target === "object" && target !== null && "dialect" in target && target.dialect === "sqlserver",
        )
        .map(([id, target]) => ({ id, capture: expandTarget(corpus, target) }));
    strict.deepEqual(
      Object.keys(facts.versions).sort(),
      [...new Set(contexts.map(({ capture }) => String(capture.target.settings.compatibilityLevel)))].sort(),
    );
    const report = sourceCoverage(facts, [{ contexts }]);
    strict.equal(Object.keys(report.contexts).length, contexts.length);
    for (const value of Object.values(facts.versions)) {
      const source = validateSourceFacts(value);
      strict.ok(source.licenseNotice.includes("MIT License"));
      strict.ok(source.grammar.productions.length > 1500);
      strict.ok(source.grammar.productions.some(({ handlers }) => handlers.length > 0));
      for (const unit of [source.common, source.grammar]) {
        const parsed = parseGrammar(unit.text);
        strict.deepEqual(parsed.classes, unit.classes);
        strict.deepEqual(parsed.symbols, unit.symbols);
        strict.deepEqual(parsed.productions, unit.productions);
        strict.equal(unit.offsetEncoding, "utf16");
      }
      strict.ok(keywordInventory(source).some(({ literal }) => literal === "select"));
      const changed = structuredClone(source);
      changed.grammar.productions[0]!.end = source.grammar.text.length + 1;
      strict.throws(() => validateSourceFacts(changed), /production span/u);
      changed.grammar.productions[0]!.end = source.grammar.productions[0]!.end;
      changed.grammar.text += " ";
      strict.throws(() => validateSourceFacts(changed), /digest/u);
    }
    strict.throws(() => sourceCoverage(facts, [{ contexts: contexts.slice(1) }]), /Stale/u);
    const first = contexts[0]!,
      unrelated = {
        ...first,
        capture: { ...first.capture, target: { ...first.capture.target, version: "unrelated" } },
      };
    strict.throws(() => sourceCoverage(facts, [{ contexts: [unrelated] }]), /stale/u);
    const changed = structuredClone(facts),
      version = Object.keys(facts.versions)[0]!;
    changed.versions[version].grammar.productions.pop();
    strict.throws(() => checkLockedFacts(lock, changed, validateSourceFacts), /disagree/u);
  });

  await it("keeps nested actions, strings, signatures and handlers separate from grammar boundaries", () => {
    const source = String.raw`header { string text = @"} "" /* opaque */"; }
class FreshParser extends Parser("Base");
options { k = 2; }
fresh[int[] inputs] returns [object result = null]
{ if (true) { string text = "; } ]"; } }
  : TOKEN (OTHER | THIRD) { string text = "{"; } ;
exception catch[Problem error] { if (true) { /* } */ Recover(); } }
class FreshLexer extends Lexer("Base");
tokens { FRESH = "fresh"; UNKNOWN; }
Bang : '!';
protected Space options { greedy = false; } : (' ' | '\n')+;
`;
    const parsed = parseGrammar(source);
    strict.deepEqual(
      parsed.productions.map(({ name, section }) => [name, section]),
      [
        ["fresh", "parser"],
        ["Bang", "lexer"],
        ["Space", "lexer"],
      ],
    );
    strict.equal(parsed.productions[0]!.handlers.length, 1);
    strict.equal(parsed.productions[1]!.literal, "!");
    strict.deepEqual(
      parsed.symbols.map(({ symbol, literal }) => [symbol, literal]),
      [
        ["FRESH", "fresh"],
        ["UNKNOWN", null],
      ],
    );
    for (const bad of [
      source.replace("fresh[int[] inputs]", "unexpected fresh[int[] inputs]"),
      source.replace("returns [object result = null]", "returns unexpected"),
      source.replace('tokens { FRESH = "fresh";', 'tokens { FRESH = "fresh"; FRESH;'),
      source.replace('FRESH = "fresh";', "FRESH = Unknown;"),
      `${source}\nprotected Space : ;`,
      `${source}\ntrailing garbage`,
      `${source}\n{`,
      `${source}\n]`,
      source.replace("exception catch[Problem error]", "exception malformed[Problem error]"),
      source.replace('Parser("Base")', 'Other("Base")'),
    ])
      strict.throws(() => parseGrammar(bad), /ScriptDOM/u);
  });
});
