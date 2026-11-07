import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import {
  duckdbBindingKey,
  duckdbSourceBinding,
} from "../../tools/grammar-catalog/src/generate/facts/duckdb-binding.mjs";
import { checkLockedFacts } from "../../tools/grammar-catalog/src/provenance/source-lock.mjs";
import {
  extractorRevision,
  parseSignatureOutput,
  validateSourceFacts,
} from "../../tools/grammar-catalog/src/sources/duckdb/facts.mjs";
import { sourceRoutine } from "../../tools/grammar-catalog/src/sources/duckdb/model.mjs";

await describe("DuckDB vendor signatures", async () => {
  await it("retains passing modes, defaults and table-option boundaries from locked vendor bytes", async () => {
    const lock = JSON.parse(await readFile(new URL("../../grammar/duckdb/sources.lock.json", import.meta.url), "utf8"));
    const catalog = JSON.parse(
      await readFile(new URL("../../grammar/duckdb/facts/catalog.json", import.meta.url), "utf8"),
    );
    checkLockedFacts(lock, catalog, validateSourceFacts);
    strict.equal(lock.extractor.revision, await extractorRevision());
    const facts = validateSourceFacts(catalog.versions["2.0.0"]);
    strict.equal(facts.registrations.length, 3235);
    const mod = facts.registrations.filter((row) => row.name === "mod");
    strict.ok(mod.length > 1);
    strict.ok(mod.every((row) => row.parameters.every((parameter) => parameter.kind === 0)));
    const avg = facts.registrations.filter((row) => row.name === "avg");
    strict.ok(avg.some((row) => row.parameters[0]?.type === "DECIMAL" && row.parameters[0].kind === 1));
    strict.ok(avg.some((row) => row.parameters[0]?.type === "BIGINT" && row.parameters[0].kind === 0));
    const range = facts.registrations.filter((row) => row.name === "range" && row.kind === "table");
    strict.ok(range.length > 0);
    strict.ok(range.every((row) => row.options.length === 0 && row.parameters.every((p) => p.kind === 0)));
    strict.ok(facts.registrations.some((row) => row.options.length > 0));
    strict.ok(facts.registrations.some((row) => row.parameters.some((parameter) => parameter.default !== null)));
    strict.ok(facts.registrations.some((row) => row.macroDefaults.length > 0));
    const forged = structuredClone(catalog);
    forged.versions["2.0.0"].registrations[0].parameters.push({
      name: "forged",
      type: "INTEGER",
      kind: 0,
      default: null,
    });
    strict.throws(() => checkLockedFacts(lock, forged, validateSourceFacts), /disagree/u);
  });
  await it("rejects truncated frames, wrong engine revisions and invalid passing modes", () => {
    const options = { version: "2.0.0", revision: "a".repeat(40), profile: "test" };
    const header = JSON.stringify({ version: "v2.0.0", sourceId: "a".repeat(10) });
    const routine = {
      schema: "main",
      name: "test",
      kind: "scalar",
      overload: 0,
      result: "INTEGER",
      definition: null,
      macroDefaults: [],
      parameters: [{ name: "input", type: "INTEGER", kind: 1, default: null }],
      options: [{ name: "option", type: "BOOLEAN", aliases: ["alias"] }],
    };
    const output = [header, JSON.stringify(routine), JSON.stringify({ registrations: 1 })].join("\n");
    strict.equal(parseSignatureOutput(output, options).registrations.length, 1);
    strict.deepEqual(parseSignatureOutput(output, options).registrations[0]?.options[0]?.aliases, ["alias"]);
    strict.throws(() => parseSignatureOutput(output.split("\n").slice(0, -1).join("\n"), options), /Incomplete/u);
    strict.throws(() => parseSignatureOutput(output, { ...options, revision: "b".repeat(40) }), /identity/u);
    const invalid = { ...routine, parameters: [{ ...routine.parameters[0], kind: 9 }] };
    strict.throws(
      () => parseSignatureOutput([header, JSON.stringify(invalid), '{"registrations":1}'].join("\n"), options),
      /Invalid/u,
    );
    strict.throws(
      () =>
        parseSignatureOutput(
          [header, JSON.stringify(routine), JSON.stringify(routine), '{"registrations":2}'].join("\n"),
          options,
        ),
      /Duplicate/u,
    );
    const positionalDefault = { ...routine, parameters: [{ name: "input", type: "INTEGER", kind: 0, default: "1" }] };
    strict.equal(
      parseSignatureOutput([header, JSON.stringify(positionalDefault), '{"registrations":1}'].join("\n"), options)
        .registrations[0]?.parameters[0]?.default,
      "1",
    );
    strict.throws(
      () =>
        parseSignatureOutput(
          [header, JSON.stringify({ ...routine, overload: 1 }), '{"registrations":1}'].join("\n"),
          options,
        ),
      /Noncontiguous/u,
    );
  });
  await it("normalizes all vendor parameter modes without reading opaque payloads during binding projection", async () => {
    const catalog = JSON.parse(
      await readFile(new URL("../../grammar/duckdb/facts/catalog.json", import.meta.url), "utf8"),
    );
    const facts = validateSourceFacts(catalog.versions["2.0.0"]);
    const routines = facts.registrations.map((registration) => ({
      registration,
      routine: sourceRoutine(registration),
    }));
    strict.equal(routines.length, facts.registrations.length);
    const mod = routines.find(({ registration }) => registration.name === "mod")!;
    strict.equal(duckdbSourceBinding(mod.routine).status, "known");
    strict.ok(mod.routine.parameters.status === "known");
    if (mod.routine.parameters.status !== "known") throw new Error("Missing MOD parameters");
    strict.ok(
      mod.routine.parameters.value.every(
        (parameter) => parameter.passing.status === "known" && parameter.passing.value === "positional-only",
      ),
    );
    const macro = routines.find(({ registration }) => registration.name === "generate_subscripts")!;
    strict.ok(macro.routine.parameters.status === "known");
    if (macro.routine.parameters.status !== "known") throw new Error("Missing macro parameters");
    strict.ok(
      macro.routine.parameters.value.some(
        (parameter) =>
          parameter.default.kind === "expression" && "sql" in parameter.default && parameter.default.sql === "1",
      ),
    );
    const erased = { ...mod.routine, properties: {} };
    strict.deepEqual(duckdbSourceBinding(erased), duckdbSourceBinding(mod.routine));
    strict.equal(duckdbBindingKey("mod", erased), duckdbBindingKey("mod", mod.routine));
    const missing = structuredClone(mod.routine);
    if (missing.parameters.status !== "known") throw new Error("missing source parameters");
    missing.parameters.value[0]!.passing = { status: "unknown", reason: "withheld evidence" };
    strict.throws(() => duckdbSourceBinding(missing), /Unqualified/u);
    missing.parameters.value[0]!.passing = { status: "known", value: "positional-only" };
    missing.parameters.value[0]!.default = { kind: "unknown", reason: "withheld evidence" };
    strict.throws(() => duckdbSourceBinding(missing), /Unqualified/u);
    const greatest = routines.find(({ registration }) => registration.name === "greatest")!;
    strict.deepEqual(duckdbSourceBinding(greatest.routine), { status: "unsupported", reason: "variadic-keyword-slot" });
  });
});
