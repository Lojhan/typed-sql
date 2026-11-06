import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { auditFunctions, auditInventory, checkReferences, grammarFor } from "../../scripts/language-audit/audit.js";
import {
  CATEGORIES,
  collectLive,
  DIALECTS,
  diffInventory,
  inventory,
  QUERIES,
  unavailable,
} from "../../scripts/language-audit/inventory.mjs";
import { reviewLive } from "../../scripts/language-audit/live-baseline.mjs";
import { recognitionQueries, recognizeLive } from "../../scripts/language-audit/recognition.js";
import { extractFunctions, extractMicrosoftToc, loadReferences } from "../../scripts/language-audit/references.js";
import { renderReport } from "../../scripts/language-audit/report.js";

await describe("independent upstream language auditing", async () => {
  await it("requires discovery adapters and upstream evidence for every grammar in the feature ledger", async () => {
    const ledger = JSON.parse(await readFile(new URL("../../grammar/features/ledger.json", import.meta.url), "utf8"));
    strict.deepEqual([...DIALECTS].sort(), Object.keys(ledger.dialects).sort());
    strict.deepEqual(Object.keys(QUERIES).sort(), Object.keys(ledger.dialects).sort());
    const references = await loadReferences();
    strict.deepEqual([...new Set(references.map((item) => item.dialect))].sort(), [...DIALECTS].sort());
  });

  await it("extracts upstream names without consulting typed-sql's function list", () => {
    const mysql = '<th scope="row"><code>NEW_VENDOR_FUNCTION()</code></th><th scope="row"><code>&amp;</code></th>';
    strict.deepEqual(extractFunctions("mysql", mysql, "https://example.test/"), [
      { name: "new_vendor_function", url: "https://example.test/" },
    ]);
    strict.deepEqual(
      extractFunctions("postgres", '<code class="function">fresh_function</code>', "https://example.test/"),
      [{ name: "fresh_function", url: "https://example.test/" }],
    );
    const sqlite =
      '<a href="c3ref/foo.html">sqlite3_step()</a><dt><p><b>new_function(X)</b></dt><h2><span>4.2. </span>The new_json() function</h2><a href="#jsonb">jsonb</a>(X)';
    strict.deepEqual(
      extractFunctions("sqlite", sqlite, "https://www.sqlite.org/json1.html").map((row) => row.name),
      ["jsonb", "new_function", "new_json"],
    );
  });

  await it("honors inherited Microsoft version constraints and multi-name entries", () => {
    const body = JSON.stringify({
      items: [
        {
          monikers: ["sql-server-ver17"],
          children: [{ toc_title: "NEW_FUNCTION", href: "t-sql/functions/new-function" }],
        },
        { toc_title: "CAST and CONVERT", href: "t-sql/functions/cast-and-convert-transact-sql" },
      ],
    });
    strict.deepEqual(
      extractMicrosoftToc(body, 16).map((row) => row.name),
      ["cast", "convert"],
    );
    strict.deepEqual(
      extractMicrosoftToc(body, 17).map((row) => row.name),
      ["new_function", "cast", "convert"],
    );
  });

  await it("detects additions, removals, changed overloads, settings context, and lost coverage", () => {
    const categories = Object.fromEntries(CATEGORIES.map((name) => [name, unavailable("not enumerable")]));
    const before = {
      dialect: "postgres",
      target: { version: "18.6", mode: "a" },
      categories: { ...categories, functions: inventory([{ name: "f", arguments: ["int"] }], "test") },
    };
    const after = {
      ...before,
      target: { version: "18.6", mode: "b" },
      categories: {
        ...before.categories,
        functions: inventory([{ name: "f", arguments: ["text"] }, { name: "new_function" }], "test"),
        keywords: inventory([{ name: "NEW_KEYWORD" }], "test"),
      },
    };
    const changes = diffInventory(before, after);
    strict.ok(changes.some((row) => row.kind === "added" && row.value.name === "new_function"));
    strict.ok(changes.some((row) => row.kind === "removed" && row.value.arguments[0] === "int"));
    strict.ok(changes.some((row) => row.kind === "context-changed"));
    strict.ok(changes.some((row) => row.kind === "coverage-changed"));
    strict.throws(() => diffInventory(before, { ...after, target: { version: "19.0" } }), /targets must match/u);
  });

  await it("never turns failed discovery or empty upstream data into a passing empty inventory", async () => {
    strict.throws(() => inventory([], "upstream"), /Empty inventory/u);
    await strict.rejects(
      collectLive(
        "postgres",
        async () => {
          throw new Error("permission denied");
        },
        { version: "18.6" },
      ),
      /permission denied/u,
    );
    await strict.rejects(
      collectLive("postgres", async () => [], { version: "18.6" }),
      /Empty inventory/u,
    );
  });

  await it("requires review for new live contexts and changes to any captured category", async () => {
    const captured = await collectLive("postgres", async () => [{ name: "one" }], { version: "18.6" });
    const first = reviewLive(captured, { targets: {} });
    strict.equal(first.status, "review-required");
    const baseline = { targets: { [first.key]: first.summary } };
    strict.equal(reviewLive(captured, baseline).status, "match");
    const changed = {
      ...captured,
      categories: { ...captured.categories, types: inventory([{ name: "new_type" }], "live") },
    };
    strict.deepEqual(reviewLive(changed, baseline).changedCategories, ["types"]);
    const omitted = { ...captured, categories: { ...captured.categories, types: undefined } };
    strict.throws(() => reviewLive(omitted, baseline), /Missing or invalid live category/u);
  });

  await it("distinguishes missing recognition from declarations and does not call either semantic proof", () => {
    const grammar = grammarFor("postgres", "18");
    const result = auditFunctions([{ name: "count" }, { name: "new_vendor_function_omitted_from_grammar" }], grammar);
    strict.equal(result.find((row) => row.name === "count")?.status, "declared-semantics-unverified");
    const gap = result.find((row) => row.name === "new_vendor_function_omitted_from_grammar");
    strict.equal(gap?.status, "unknown-function-observed");
    strict.ok(gap?.diagnostics?.some((message) => /Unknown function/u.test(message)));
    const categories = { functions: { ...inventory([{ name: "count" }], "test"), fingerprint: "tampered" } };
    strict.throws(() => auditInventory({ dialect: "postgres", target: { version: "18" }, categories }), /fingerprint/u);
  });

  await it("generates signature and context probes from upstream facts and requires native acceptance", async () => {
    strict.deepEqual(recognitionQueries({ name: "vendor_window", kind: "window", arguments: ["INTEGER"] }), [
      "SELECT vendor_window(CAST(NULL AS INTEGER)) OVER () AS value",
    ]);
    strict.deepEqual(recognitionQueries({ name: "vendor_table", kind: "table", arity: 0 }), [
      "SELECT * FROM vendor_table()",
    ]);
    strict.deepEqual(recognitionQueries({ name: "unsafe;name", arity: 0 }), []);
    const rejected = await recognizeLive(
      "postgres",
      "18.6",
      [{ name: "future_vendor_function", arity: 1 }],
      async () => ({ accepted: false, reason: "invalid signature" }),
    );
    strict.equal(rejected.observations[0]?.status, "native-rejected-generated-invocation");
    const accepted = await recognizeLive(
      "postgres",
      "18.6",
      [{ name: "future_vendor_function", arity: 1 }],
      async () => ({ accepted: true }),
    );
    strict.equal(accepted.observations[0]?.status, "native-valid-grammar-diagnostic");
    await strict.rejects(
      recognizeLive("postgres", "18.6", [{ name: "count", arity: 1 }], async () => {
        throw new Error("connection lost");
      }),
      /connection lost/u,
    );
  });

  await it("keeps the reviewed mapping observations and generated gap report current", async () => {
    await checkReferences();
    await renderReport(true);
  });
});
