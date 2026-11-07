import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import {
  addCapture,
  emptyCorpus,
  readCorpus,
  verifyCaptureInput,
  writeCorpus,
} from "../../scripts/catalog-generation/corpus.mjs";
import { groupCorpus } from "../../scripts/catalog-generation/model.mjs";
import { CATEGORIES, inventory, unavailable } from "../../scripts/language-audit/inventory.mjs";
import { builtinMappers } from "../../tools/grammar-catalog/src/mappers/index.mjs";
import { routineSignature } from "../../tools/grammar-catalog/src/model/routines.mjs";
import { createMapperRegistry, numericVersionBand } from "../../tools/grammar-catalog/src/registry.mjs";

const mapper = {
  id: "synthetic",
  versionBand: numericVersionBand(2),
  normalizeRow: (_category: string, row: unknown) => row,
  routineFacts: () => ({ parameters: [], result: "result_type", returnsSet: false }),
};

await describe("grammar-independent catalog mapper registrations", async () => {
  await it("supports an external grammar and inherited graph contribution without modifying shared mechanics", () => {
    const base = createMapperRegistry([mapper]);
    const registry = base.extend([
      {
        id: "synthetic/graph",
        extends: "synthetic",
        routineFacts: () => ({
          parameters: [
            { name: "graph", inputPosition: 1, position: 1, nativeType: "graph", mode: "input", hasDefault: true },
          ],
          resultColumns: [{ name: "vertex", nativeType: "vertex", nullable: null }],
          returnsSet: true,
        }),
      },
    ]);
    strict.deepEqual(base.ids, ["synthetic"]);
    strict.deepEqual(registry.ids, ["synthetic", "synthetic/graph"]);
    strict.equal(registry.get("synthetic/graph").versionBand("7.2.3"), "7.2");
    const result = routineSignature(registry.get("synthetic/graph"), { name: "vertices", namespace: "graph" });
    strict.equal(result.namespace, "graph");
    strict.equal(result.parameters?.[0]?.name, "graph");
    strict.equal(result.parameters?.[0]?.hasDefault, true);
    strict.equal(result.result.returnsSet, true);
    strict.deepEqual(result.result.columns, [{ name: "vertex", nativeType: "vertex", nullable: null }]);
    strict.equal(result.result.nullable, null);
    strict.equal(routineSignature(base.get("synthetic"), { name: "value" }).result.nativeType, "result_type");
  });

  await it("rejects unknown, duplicate, incomplete and cyclic mapper registrations", () => {
    strict.throws(() => createMapperRegistry([mapper, mapper]), /Duplicate/u);
    strict.throws(() => createMapperRegistry([{ id: "bad" }]), /Missing/u);
    strict.throws(() => createMapperRegistry([{ id: "bad", extends: "absent" }]), /Unregistered/u);
    strict.throws(
      () =>
        createMapperRegistry([
          { id: "a", extends: "b" },
          { id: "b", extends: "a" },
        ]),
      /Cyclic/u,
    );
    strict.throws(() => createMapperRegistry([mapper]).get("absent"), /Unregistered/u);
    strict.throws(() => numericVersionBand(0), /width/u);
    strict.throws(() => mapper.versionBand("7"), /version/u);
    strict.equal(builtinMappers.get("postgres").versionBand("19beta3"), "19");
  });

  await it("imports, verifies, writes and groups an external grammar contribution through the real corpus pipeline", async () => {
    const registry = createMapperRegistry([mapper]).extend([{ id: "synthetic/graph", extends: "synthetic" }]);
    const native = { name: "vertices", namespace: "graph", result: "vertex" };
    const row = { ...native, signature: routineSignature(registry.get("synthetic/graph"), native) };
    const input = {
      dialect: "synthetic/graph",
      target: { version: "7.2.3", extension: "graph-1" },
      categories: Object.fromEntries(
        CATEGORIES.map((name) => [
          name,
          name === "functions"
            ? inventory([row], "external-native-registry")
            : unavailable("No observations in fixture"),
        ]),
      ),
    };
    const corpus = emptyCorpus();
    await addCapture(corpus, input, registry);
    strict.equal((await verifyCaptureInput(input, corpus, registry)).status, "match");
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-external-catalog-"));
    try {
      const path = join(directory, "facts.json");
      await writeCorpus(corpus, path, registry);
      const restored = await readCorpus(path, registry);
      const [group] = groupCorpus(restored, registry);
      if (!group) throw new Error("External contribution group is missing");
      strict.equal(group.dialect, "synthetic/graph");
      strict.equal(group.version, "7.2");
      strict.deepEqual(group.categories.functions!.rows, [row]);
      await strict.rejects(readCorpus(path), /Unregistered/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("normalizes SQLite wire integers without collapsing dynamic type knowledge", () => {
    const sqlite = builtinMappers.get("sqlite");
    const wire = { name: "abs", arity: "1", builtin: "1", flags: "2099200" };
    const numeric = sqlite.normalizeRow("functions", wire);
    strict.deepEqual(numeric, { name: "abs", arity: 1, builtin: 1, flags: 2099200 });
    strict.equal(wire.arity, "1");
    strict.deepEqual(
      sqlite.normalizeRow("functions", { name: "abs", arity: 1n, builtin: 1n, flags: 2099200n }),
      numeric,
    );
    strict.equal(routineSignature(sqlite, { name: "iif", arity: -4n }).variadic, true);
    for (const arity of [null, true, "", "1junk", "1.5", Number.MAX_SAFE_INTEGER + 1])
      strict.throws(() => sqlite.normalizeRow("functions", { ...wire, arity }), /integer/u);
    const facts = routineSignature(sqlite, numeric);
    strict.equal(facts.result.typeKnowledge, "dynamic-or-unavailable");
    strict.equal(facts.parameters?.[0]?.nativeType, null);
    strict.equal(facts.result.nullable, null);
    for (const arity of [-1, -3, -4]) {
      const variadic = routineSignature(sqlite, sqlite.normalizeRow("functions", { ...wire, arity }));
      strict.equal(variadic.variadic, true);
      strict.equal(variadic.parameters, null);
      strict.equal(variadic.result.typeKnowledge, "dynamic-or-unavailable");
    }
    for (const arity of [-2, -5, 32768])
      strict.throws(() => sqlite.normalizeRow("functions", { ...wire, arity }), /arity/u);
    // A foreign grammar's negative sentinel has no shared SQLite meaning.
    const foreign = routineSignature(
      { ...mapper, routineFacts: () => ({ parameters: null, registration: true }) },
      { name: "foreign", arity: -1 },
    );
    strict.equal(foreign.variadic, null);
  });

  await it("validates every retained legacy signature and recovers shared SQLite facts across wrappers", async () => {
    const corpus = await readCorpus();
    const group = groupCorpus(corpus).find((entry) => entry.dialect === "sqlite" && entry.version === "3.53.4");
    if (!group) throw new Error("SQLite native contexts are missing");
    strict.equal(group.contexts.length, 4);
    strict.ok(group.categories.functions!.rows!.length >= 140);
    strict.ok(group.categories.functions!.rows!.some((row) => row.name === "abs"));
    // Normalization changes the shared view, never the archived native capture.
    const rows = Object.values(corpus.rows) as { name: string; arity?: unknown }[];
    strict.ok(rows.some((row) => row.name === "abs" && typeof row.arity === "string"));
  });
});
