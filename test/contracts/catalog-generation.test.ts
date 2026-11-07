import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import {
  addCapture,
  emptyCorpus,
  expandTarget,
  readCorpus,
  validateCorpus,
  verifyCaptureInput,
  writeCorpus,
} from "../../scripts/catalog-generation/corpus.mjs";
import { decodeFunctions, generateCatalogs, validateParserPolicy } from "../../scripts/catalog-generation/generate.mjs";
import { duckdbCombinations, groupCorpus, targetSeries } from "../../scripts/catalog-generation/model.mjs";
import { generationReport } from "../../scripts/catalog-generation/report.mjs";
import { grammarFor } from "../../scripts/language-audit/audit.js";
import { compareNativeDescription } from "../../scripts/language-audit/description.js";
import { collectLive, hash, inventory } from "../../scripts/language-audit/inventory.mjs";
import { acceptLiveBaseline, reviewLive } from "../../scripts/language-audit/live-baseline.mjs";
import { preparePostgres } from "../../scripts/language-audit/native.mjs";
import { extractSqliteStrictTypes } from "../../scripts/language-audit/references.js";

const capture = () => collectLive("postgres", async () => [{ name: "discovered" }], { version: "18.6" });

await describe("reproducible native catalog generation", async () => {
  await it("retains facts independently of inference approval and refuses to baseline a type disagreement", async () => {
    const input = { ...(await capture()), recognition: { counts: { "native-valid-type-mismatch": 1 } } };
    const corpus = emptyCorpus();
    await addCapture(corpus, input);
    strict.equal(Object.keys(corpus.targets).length, 1);
    strict.equal(reviewLive(input, { targets: {} }).status, "invalid-inference");
    await strict.rejects(acceptLiveBaseline(input), /cannot be accepted/u);
    strict.equal((await verifyCaptureInput(input, corpus)).status, "match");
  });

  await it("requires matching fresh facts for every category and refuses corrupted captures", async () => {
    const input = await capture();
    const corpus = emptyCorpus();
    await addCapture(corpus, input);
    strict.equal((await verifyCaptureInput({ ...input, target: { version: "19.0" } }, corpus)).status, "missing");
    for (const category of Object.keys(input.categories)) {
      const changed = {
        ...input,
        categories: { ...input.categories, [category]: inventory([{ name: "new_native_fact" }], "independent") },
      };
      strict.deepEqual((await verifyCaptureInput(changed, corpus)).changedCategories, [category]);
    }
    const broken = structuredClone(input);
    broken.categories.functions!.rows![0]!.name = "corrupted";
    await strict.rejects(verifyCaptureInput(broken, corpus), /Invalid live inventory/u);
    const row = Object.values(corpus.rows)[0] as { name: string };
    row.name = "corrupted";
    strict.throws(() => validateCorpus(corpus), /Invalid captured row/u);
  });

  await it("round-trips compact facts deterministically and excludes context disagreements from shared catalogs", async () => {
    const input = await capture();
    const corpus = emptyCorpus();
    await addCapture(corpus, input);
    await addCapture(corpus, {
      ...input,
      target: { version: "18.7", mode: "different" },
      categories: { ...input.categories, types: inventory([{ name: "context_specific" }], "independent") },
    });
    const groups = groupCorpus(corpus);
    strict.equal(groups.length, 1);
    strict.equal(groups[0].categories.types.rows.length, 0);
    strict.equal(groups[0].categories.types.excludedContextRows, 2);
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-generation-"));
    try {
      const path = join(directory, "corpus.json");
      await writeCorpus(corpus, path);
      const before = await readFile(path, "utf8");
      const restored = await readCorpus(path);
      await writeCorpus(restored, path);
      strict.equal(await readFile(path, "utf8"), before);
      const first = Object.values(restored.targets)[0];
      strict.deepEqual(expandTarget(restored, first).categories.functions.rows, input.categories.functions!.rows);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    await strict.rejects(
      generateCatalogs(corpus, { check: true, requiredTargets: [{ dialect: "postgres", version: "19" }] }),
      /Missing native generation input/u,
    );
    strict.equal(targetSeries("postgres", "19beta3"), "19");
    strict.equal(targetSeries("sqlserver", "17.0.1.2"), "17");
  });

  await it("makes even audit-only facts invalidate the generated input revision", async () => {
    const input = await capture();
    const corpus = emptyCorpus();
    await addCapture(corpus, input);
    const before = generationReport(corpus, groupCorpus(corpus), {}, []);
    await addCapture(corpus, {
      ...input,
      categories: { ...input.categories, settings: inventory([{ name: "new_setting" }], "native") },
    });
    const after = generationReport(corpus, groupCorpus(corpus), {}, []);
    strict.notEqual(before.inputFingerprint, after.inputFingerprint);
    strict.deepEqual(Object.keys(after.bands[0].categories), Object.keys(input.categories));
    const actual = await readCorpus();
    strict.deepEqual(
      [...new Set(Object.values(actual.targets).map((target) => (target as { dialect: string }).dialect))].sort(),
      ["duckdb", "mysql", "postgres", "sqlite", "sqlserver"],
    );
  });

  await it("rejects malformed semantic policies and incomplete native combination tables", () => {
    strict.throws(() => validateParserPolicy({ keywords: ["SELECT"], operators: ["<", "<="] }), /hides a longer/u);
    strict.throws(() => validateParserPolicy({ keywords: ["SELECT", "SELECT"], operators: ["+"] }), /unique/u);
    const entry = { name: "NATIVE_FUNCTION", kind: "scalar", result: "explicit-policy", arguments: [0, "unbounded"] };
    strict.equal(decodeFunctions([entry])[0].arguments[1], Infinity);
    strict.throws(() => decodeFunctions([{ ...entry, arguments: [2, 1] }]), /Invalid argument bounds/u);
    strict.throws(() => decodeFunctions([entry, entry]), /Duplicate function policy/u);
    const facts = {
      formatVersion: 1,
      version: "2.0.0",
      source: "native",
      inventoryFingerprint: hash("facts"),
      matrices: { set: [{ left: "A", right: "A", result: "A" }], expression: [{ left: "A", right: "A", result: "A" }] },
    };
    strict.deepEqual(duckdbCombinations(facts, "2.0.0", (name: string) => name).set, { "A|A": "A" });
    facts.matrices.set.push({ left: "B", right: "B", result: "B" });
    strict.throws(() => duckdbCombinations(facts, "2.0.0", (name: string) => name), /Incomplete/u);
    strict.deepEqual(
      extractSqliteStrictTypes(
        "The datatype must be one of the following:<ul><li>INT</li><li>NEW_TYPE</li></ul>",
        "https://example.test/strict",
      ).map((row) => row.name),
      ["INT", "NEW_TYPE"],
    );
    strict.throws(() => extractSqliteStrictTypes("No type inventory", "https://example.test/strict"));
  });

  await it("compares concrete native identities and leaves missing descriptions or unknown analysis unverified", () => {
    for (const [dialect, version, sql, type, other] of [
      ["postgres", "18", "SELECT 1::int AS value", "integer", "text"],
      ["duckdb", "2.0.0", "SELECT 1::INTEGER AS value", "INTEGER", "VARCHAR"],
      ["sqlserver", "17", "SELECT CAST(1 AS int) AS value", "int", "varchar(30)"],
    ]) {
      const result = grammarFor(dialect!, version!).analyze(sql!);
      strict.equal(
        compareNativeDescription(dialect!, version!, { columns: [{ nativeType: type }], parameterCount: 0 }, result)
          .status,
        "native-identities-match",
      );
      strict.equal(
        compareNativeDescription(dialect!, version!, { columns: [{ nativeType: other }] }, result).status,
        "mismatch",
      );
      strict.equal(
        compareNativeDescription(dialect!, version!, { columns: [{ nativeType: null }] }, result).status,
        "unverified",
      );
      strict.equal(
        compareNativeDescription(
          dialect!,
          version!,
          { columns: [{ nativeType: type }] },
          { ...result, columns: result.columns.map((column) => ({ ...column, tsType: "unknown" })) },
        ).status,
        "unverified",
      );
    }
  });

  await it("describes PostgreSQL inputs and outputs without sending Bind or Execute", async () => {
    const calls: string[] = [];
    const connection = Object.assign(new EventEmitter(), {
      parse: () => calls.push("parse"),
      describe: () => calls.push("describe"),
      sync: () => calls.push("sync"),
      bind: () => {
        throw new Error("discovered SQL must not bind");
      },
      execute: () => {
        throw new Error("discovered SQL must not execute");
      },
    });
    interface Request {
      submit(wire: typeof connection): void;
      handleRowDescription(message: { fields: { name: string; dataTypeID: number; dataTypeModifier: number }[] }): void;
      handleReadyForQuery(): void;
    }
    const client = {
      connection,
      query(request: string | Request) {
        if (typeof request === "string") return Promise.resolve({ rows: [{ oid: "23", name: "integer" }] });
        request.submit(connection);
        connection.emit("parameterDescription", { dataTypeIDs: [23] });
        request.handleRowDescription({ fields: [{ name: "value", dataTypeID: 23, dataTypeModifier: -1 }] });
        request.handleReadyForQuery();
      },
    };
    const result = await preparePostgres(client, "SELECT potentially_volatile($1)");
    strict.deepEqual(calls, ["parse", "describe", "sync"]);
    strict.equal(connection.listenerCount("parameterDescription"), 0);
    strict.equal(result.metadata?.parameters[0].nativeType, "integer");
    strict.equal(result.metadata?.columns[0].nativeType, "integer");
  });
});
