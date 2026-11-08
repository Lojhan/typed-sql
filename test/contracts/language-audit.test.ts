import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { auditFunctions, auditInventory, checkReferences, grammarFor } from "../../scripts/language-audit/audit.js";
import {
  CATEGORIES,
  canonicalDuckFunction,
  collectLive,
  DIALECTS,
  diffInventory,
  hash,
  inventory,
  QUERIES,
  unavailable,
} from "../../scripts/language-audit/inventory.mjs";
import { compactFindings, expandFindings, reviewLive } from "../../scripts/language-audit/live-baseline.mjs";
import { prepareMySql } from "../../scripts/language-audit/native.mjs";
import { recognitionQueries, recognizeLive } from "../../scripts/language-audit/recognition.js";
import {
  extractFunctions,
  extractMicrosoftToc,
  loadReferences,
  textContent,
} from "../../scripts/language-audit/references.js";
import { renderReport } from "../../scripts/language-audit/report.js";
import { signatureFacts } from "../../scripts/language-audit/signatures.mjs";

await describe("independent upstream language auditing", async () => {
  await it("requires discovery adapters and upstream evidence for every grammar in the feature ledger", async () => {
    const ledger = JSON.parse(await readFile(new URL("../../grammar/features/ledger.json", import.meta.url), "utf8"));
    strict.deepEqual([...DIALECTS].sort(), Object.keys(ledger.dialects).sort());
    strict.deepEqual(Object.keys(QUERIES).sort(), Object.keys(ledger.dialects).sort());
    const references = await loadReferences();
    strict.deepEqual([...new Set(references.map((item) => item.dialect))].sort(), [...DIALECTS].sort());
    for (const reference of references) {
      if (reference.sources) continue;
      for (const [category, query] of Object.entries(QUERIES[reference.dialect as keyof typeof QUERIES])) {
        if (reference.categories[category]?.status === "observed")
          strict.equal(
            reference.categories[category].source,
            query,
            `${reference.dialect} ${category} capture needs refresh`,
          );
      }
    }
  });

  await it("discards complete and incomplete tags when extracting reference text", () => {
    strict.equal(textContent(" <b>function_name</b>&nbsp;&amp;&#160;argument "), "function_name & argument");
    strict.equal(textContent("function_name<script"), "function_name");
    strict.equal(textContent("function_name<scr<script>ipt>"), "function_nameipt>");
    strict.equal(textContent("<script"), "");
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
    const server = {
      ...captured,
      dialect: "sqlserver",
      target: {
        version: "16.0.1.0",
        settings: { databaseName: "temporary_a", compatibilityLevel: 160, collation: "x" },
      },
    };
    const reviewed = reviewLive(server, { targets: {} });
    const stable = { targets: { [reviewed.key]: reviewed.summary } };
    strict.equal(
      reviewLive(
        {
          ...server,
          target: { ...server.target, settings: { ...server.target.settings, databaseName: "temporary_b" } },
        },
        stable,
      ).status,
      "match",
    );
    strict.equal(
      reviewLive(
        { ...server, target: { ...server.target, settings: { ...server.target.settings, collation: "y" } } },
        stable,
      ).status,
      "review-required",
    );
  });

  await it("preserves positional types and named-option associations independently of hash-map order", () => {
    const first = canonicalDuckFunction({
      name: "vendor_table",
      kind: "table",
      parameter_names: ["col0", "last", "first"],
      arguments: ["VARCHAR", "BOOLEAN", "INTEGER"],
    });
    const reordered = canonicalDuckFunction({
      name: "vendor_table",
      kind: "table",
      parameter_names: ["col0", "first", "last"],
      arguments: ["VARCHAR", "INTEGER", "BOOLEAN"],
    });
    strict.deepEqual(first, reordered);
    strict.deepEqual(first.arguments, ["VARCHAR"]);
    strict.deepEqual(first.named_arguments, { first: "INTEGER", last: "BOOLEAN" });
    strict.notDeepEqual(
      first,
      canonicalDuckFunction({
        name: "vendor_table",
        kind: "table",
        parameter_names: ["col0", "last", "first"],
        arguments: ["VARCHAR", "INTEGER", "BOOLEAN"],
      }),
    );
    strict.throws(
      () => canonicalDuckFunction({ name: "vendor_table", kind: "table", arguments: ["VARCHAR"] }),
      /Incomplete DuckDB/u,
    );
  });

  await it("uses public MySQL metadata and discards help prose and setting values", async () => {
    const queries: string[] = [];
    const captured = await collectLive(
      "mysql",
      async (sql: string) => {
        queries.push(sql);
        if (sql === "SHOW GLOBAL VARIABLES") return [{ Variable_name: "sql_mode", Value: "do-not-record-value" }];
        if (sql.startsWith("HELP "))
          return [{ name: "vendor_topic", is_it_category: "N", description: "do-not-record-prose" }];
        return [{ name: "one" }];
      },
      { version: "8.4.11" },
    );
    strict.ok(queries.some((sql) => sql === "HELP 'Data Types'"));
    strict.ok(queries.every((sql) => !sql.includes("mysql.help_") && !sql.includes("performance_schema")));
    strict.ok(!JSON.stringify(captured).includes("do-not-record"));
  });

  await it("shares identical native evidence across versions without dropping context or accepting corrupt rows", () => {
    const observations = [
      {
        name: "vendor_function",
        sql: "SELECT vendor_function(NULL)",
        status: "native-valid-grammar-diagnostic",
        diagnostics: ["unknown function"],
      },
    ];
    const first = { target: { version: "1" }, fingerprint: hash(observations), observations };
    const second = { ...first, target: { version: "2" } };
    const data = { formatVersion: 1, targets: { first, second } };
    const compact = compactFindings(data);
    strict.equal(Object.keys(compact.observations).length, 1);
    strict.deepEqual(expandFindings(compact), data);
    const corrupt = structuredClone(compact);
    const id = Object.keys(corrupt.observations)[0]!;
    corrupt.observations[id].status = "tampered";
    strict.throws(() => expandFindings(corrupt), /Invalid shared native observation/u);
  });

  await it("preserves independent MySQL parameter descriptors instead of copying result dimensions", async () => {
    let closed = 0;
    const captured = await prepareMySql(
      {
        prepare: async () => ({
          statement: {
            columns: [{ name: "value", columnType: 246, columnLength: 14, decimals: 3, flags: 128, characterSet: 63 }],
            parameters: [{ name: "?", columnType: 246, columnLength: 67, decimals: 30, flags: 128, characterSet: 63 }],
          },
          close: async () => {
            closed++;
          },
        }),
      },
      "SELECT CAST(? AS DECIMAL(12,3)) AS value",
    );
    strict.equal(captured.accepted, true);
    strict.equal(closed, 1);
    strict.deepEqual(captured.metadata, {
      status: "native preparation metadata for this invocation",
      columns: [{ name: "value", engineType: 246, columnLength: 14, decimals: 3, flags: 128, characterSet: 63 }],
      parameterCount: 1,
      parameters: [
        { index: 1, name: "?", engineType: 246, columnLength: 67, decimals: 30, flags: 128, characterSet: 63 },
      ],
    });
    const missing = await prepareMySql(
      {
        prepare: async () => ({ statement: { columns: [] }, close: async () => {} }),
      },
      "SELECT ? AS value",
    );
    strict.equal(missing.metadata.parameterCount, null, "A missing parameter block must not become zero inputs");
    strict.equal(Object.hasOwn(missing.metadata, "parameters"), false);
  });

  await it("recognizes modern MySQL server rejections without swallowing transport failures", async () => {
    const rejected = await prepareMySql(
      {
        prepare: async () => {
          throw Object.assign(new Error("invalid window context"), {
            code: "ER_WINDOW_INVALID_WINDOW_FUNC_USE",
            errno: 3593,
            sqlState: "HY000",
          });
        },
      },
      "SELECT vendor_window()",
    );
    strict.equal(rejected.accepted, false);
    await strict.rejects(
      prepareMySql(
        {
          prepare: async () => {
            throw Object.assign(new Error("connection lost"), { code: "ECONNRESET" });
          },
        },
        "SELECT 1",
      ),
      /connection lost/u,
    );
  });

  await it("retains generation-ready parameter facts without inventing missing types or nullability", () => {
    const postgres = signatureFacts("postgres", {
      name: "vendor_function",
      namespace: "pg_catalog",
      kind: "f",
      argument_types: ["integer", "text[]"],
      all_argument_types: ["integer", "text[]", "boolean"],
      parameter_names: ["count", "values", "ok"],
      parameter_modes: ["i", "v", "o"],
      input_count: 2,
      defaults: 1,
      default_expressions_sql: "ARRAY[]::text[]",
      variadic: true,
      variadic_type: "text",
      result: "boolean",
      strict: true,
    });
    strict.equal(postgres.parameters![1]!.name, "values");
    strict.equal(postgres.parameters![1]!.variadic, true);
    strict.equal(postgres.parameters![1]!.hasDefault, true);
    strict.equal(postgres.parameters![2]!.inputPosition, null);
    strict.equal(postgres.result.nullable, null);
    strict.equal(postgres.properties.strict, true);
    strict.equal(postgres.defaultExpressions, "ARRAY[]::text[]");
    const sqlite = signatureFacts("sqlite", { name: "vendor_function", kind: "s", arity: 2, encoding: "utf8" });
    strict.equal(sqlite.parameters!.length, 2);
    strict.equal(sqlite.parameters![0]!.nativeType, null);
    const reference = signatureFacts("mysql", { name: "vendor_function" });
    strict.equal(reference.parameters, null);
    strict.equal(reference.variadic, null);
    strict.equal(reference.result.returnsSet, null);
    const sqlserver = signatureFacts("sqlserver", {
      name: "vendor_function",
      kind: "FN",
      parameters_json: JSON.stringify([
        { position: 0, type_name: "int" },
        { position: 1, name: "@value", type_name: "nvarchar", max_length: 80, has_default_value: false },
      ]),
      return_columns_json: "[]",
    });
    strict.equal(sqlserver.parameters![0]!.hasDefault, null);
    strict.equal(sqlserver.result.nativeType, "int");
    strict.equal(
      signatureFacts("sqlserver", { name: "hidden_system_routine", parameters_json: null }).parameters,
      null,
    );
    strict.throws(
      () => signatureFacts("sqlserver", { name: "vendor_function", parameters_json: "{}" }),
      /Invalid SQL Server/u,
    );
  });

  await it("distinguishes missing recognition from declarations and does not call either semantic proof", () => {
    const grammar = grammarFor("postgres", "18");
    const result = auditFunctions([{ name: "count" }, { name: "new_vendor_function_omitted_from_grammar" }], grammar);
    strict.equal(result.find((row) => row.name === "count")?.status, "declared-semantics-unverified");
    const gap = result.find((row) => row.name === "new_vendor_function_omitted_from_grammar");
    strict.equal(gap?.status, "unknown-function-observed");
    strict.ok(gap?.diagnostics?.some((message) => /Unknown function/u.test(message)));
    const duckDBGap = auditFunctions(
      [{ name: "new_vendor_function_omitted_from_grammar" }],
      grammarFor("duckdb", "2.0.0"),
    )[0];
    strict.equal(duckDBGap?.status, "unknown-function-observed");
    strict.ok(duckDBGap?.diagnostics?.some((message) => message.startsWith("TSQ408:")));
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
