import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import type { DialectServerEvidence } from "../../packages/core/src/index.js";
import { readCorpus } from "../../scripts/catalog-generation/corpus.mjs";
import { normalizedCorpus } from "../../scripts/catalog-generation/model.mjs";
import { auditInventory, grammarFor } from "../../scripts/language-audit/audit.js";
import type { AuditGrammar } from "../../scripts/language-audit/grammars/contracts.js";
import { builtinAuditGrammars } from "../../scripts/language-audit/grammars/index.js";
import { createAuditGrammarRegistry } from "../../scripts/language-audit/grammars/registry.js";
import { inventory } from "../../scripts/language-audit/inventory.mjs";
import { createNativeDescriptionRegistry } from "../../scripts/language-audit/native-description/index.js";
import { recognitionQueries, recognizeLive } from "../../scripts/language-audit/recognition.js";

await describe("registered grammar auditing", async () => {
  await it("constructs every retained grammar context through its registered owner", async () => {
    const ledger = JSON.parse(await readFile(new URL("../../grammar/features/ledger.json", import.meta.url), "utf8"));
    strict.deepEqual([...builtinAuditGrammars.ids].sort(), Object.keys(ledger.dialects).sort());
    const corpus = await readCorpus();
    for (const target of Object.values(normalizedCorpus(corpus).catalog.profiles)) {
      const grammar = grammarFor(target.grammar, target.version);
      strict.ok(grammar.names.size > 0, `${target.grammar} ${target.version}`);
      strict.equal(typeof grammar.tokenize("SELECT")[0]?.kind, "string");
      const result = grammar.analyze("SELECT 1 AS value");
      strict.deepEqual(result.diagnostics, []);
      strict.equal(result.columns.length, 1);
      strict.notEqual(result.columns[0]?.tsType, "unknown");
      strict.notEqual(result.columns[0]?.tsType, "any");
    }
  });

  await it("runs an inherited graph adapter through inventory, native probes and independent comparison", async () => {
    const received: { version: string; server: DialectServerEvidence | undefined }[] = [];
    const analyzed: string[] = [];
    const base: AuditGrammar = {
      id: "vendor/base",
      versionBand: (version) => version.split(".")[0]!,
      tokenize: () => [{ kind: "keyword" }],
      planInvocations: () => ["SELECT graph_base() AS value"],
      planEntity: () => undefined,
      createAnalysis(version, server) {
        received.push({ version, server });
        return {
          names: new Set(["graph_node"]),
          analyze: (sql) => {
            analyzed.push(sql);
            return {
              columns: [
                {
                  name: "value",
                  tsType: "GraphNode",
                  databaseType: "graph_node",
                  nullable: false,
                  range: { start: 7, end: 21, line: 1, column: 8 },
                },
              ],
              parameters: sql.includes("$1")
                ? [{ index: 1, tsType: "string", databaseType: "text", nullable: true }]
                : [],
              diagnostics: [],
            };
          },
        };
      },
    };
    const original = createAuditGrammarRegistry([base]);
    base.planInvocations = () => {
      throw new Error("Caller mutated its original definition");
    };
    const id = "vendor/graph";
    const registry = original.extend([
      {
        id,
        extends: base.id,
        planInvocations: () => ["SELECT graph_node($1) AS value"],
        planEntity: (_category, name) => `GRAPH DESCRIBE ${name}`,
      },
    ]);
    strict.deepEqual(original.ids, [base.id]);
    strict.throws(() => original.get(id), /Unregistered/u);
    strict.deepEqual(registry.get(base.id).planInvocations({ name: "graph_node" }), ["SELECT graph_base() AS value"]);
    const audit = auditInventory(
      {
        dialect: id,
        target: { version: "2.4.3" },
        categories: {
          functions: inventory([{ name: "graph_node" }], "independent graph source"),
          keywords: inventory([{ name: "GRAPH_MATCH" }], "independent graph source"),
          types: inventory([{ name: "graph_node" }], "independent graph source"),
        },
      },
      registry,
    );
    strict.equal(audit.categories.functions?.observations?.[0]?.status, "declared-semantics-unverified");
    strict.equal(audit.categories.keywords?.observations?.[0]?.status, "keyword-token-observed");
    strict.deepEqual(analyzed, ["GRAPH DESCRIBE graph_node"]);
    const descriptions = createNativeDescriptionRegistry([
      {
        id,
        claimSql: (type) => `DESCRIBE GRAPH TYPE ${type}`,
        identity: (descriptor) => descriptor.nativeType ?? undefined,
      },
    ]);
    const queries: string[] = [];
    const server = { product: "vendor", version: "2.4.3", versionKey: "2", features: ["graph"], settings: {} };
    const result = await recognizeLive(
      id,
      "2.4.3",
      [{ name: "graph_node" }],
      async (sql) => {
        queries.push(sql);
        const claim = sql.startsWith("DESCRIBE GRAPH TYPE ");
        return {
          accepted: true,
          metadata: {
            columns: [{ nativeType: claim ? sql.slice("DESCRIBE GRAPH TYPE ".length) : "graph_node" }],
            parameterCount: claim ? 0 : 1,
            ...(claim ? {} : { parameters: [{ index: 1, nativeType: "text" }] }),
          },
        };
      },
      server,
      { registry, descriptions },
    );
    strict.equal(result.observations[0]?.nativeTypeComparison?.status, "native-identities-match");
    strict.deepEqual(queries, [
      "SELECT graph_node($1) AS value",
      "DESCRIBE GRAPH TYPE graph_node",
      "DESCRIBE GRAPH TYPE text",
    ]);
    strict.deepEqual(received, [
      { version: "2", server: undefined },
      { version: "2", server },
    ]);
  });

  await it("rejects incomplete contributions, unknown parents and cycles before running probes", () => {
    strict.throws(() => createAuditGrammarRegistry([{ id: "incomplete" }]), /Missing catalog mapper/u);
    strict.throws(() => createAuditGrammarRegistry([{ id: "child", extends: "absent" }]), /Unregistered/u);
    strict.throws(
      () =>
        createAuditGrammarRegistry([
          { id: "child", extends: "parent" },
          { id: "parent", extends: "child" },
        ]),
      /Cyclic/u,
    );
    strict.throws(() => recognitionQueries({ name: "anything" }, "unregistered"), /Unregistered/u);
  });

  await it("classifies protocol rejection codes with and without native message details", () => {
    const postgres = builtinAuditGrammars.get("postgres").invocationShapeSyntax!;
    strict.equal(postgres.rejection("42883"), "binding");
    strict.equal(postgres.rejection("42883: function does not exist"), "binding");
    strict.equal(postgres.rejection("22P02"), "value");
    strict.equal(postgres.rejection("42501"), "unclassified");
    const sqlserver = builtinAuditGrammars.get("sqlserver").invocationShapeSyntax!;
    for (const reason of ["195", "42000:195", "42000:195: unrecognized function"])
      strict.equal(sqlserver.rejection(reason), "binding");
    strict.equal(sqlserver.rejection("42000:229"), "unclassified");
  });

  await it("keeps shared analysis and probe assembly free of grammar implementation imports and ID dispatch", async () => {
    for (const file of [
      "audit.ts",
      "recognition.ts",
      "invocations.ts",
      "grammars/registry.ts",
      "run.ts",
      "connections/registry.ts",
      "references.ts",
      "reference-sources/registry.ts",
    ]) {
      const source = await readFile(new URL(`../../scripts/language-audit/${file}`, import.meta.url), "utf8");
      strict.doesNotMatch(source, /packages\/(?!core\/)/u, file);
      strict.doesNotMatch(source, /\b(?:dialect|grammar)\s*(?:===?|!==?)\s*["'][a-z]/u, file);
    }
  });
});
