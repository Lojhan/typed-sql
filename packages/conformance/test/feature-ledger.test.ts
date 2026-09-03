import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import {
  compareGrammarVersions,
  defineGrammarFeatureLedger,
  FEATURE_LEDGER_FORMAT_VERSION,
  featureSupport,
  featureSupportAtVersion,
  type GrammarFeatureLedger,
  grammarVersionInRange,
  parseGrammarFeatureLedger,
} from "../src/index.js";

const minimal = {
  formatVersion: FEATURE_LEDGER_FORMAT_VERSION,
  dialects: {
    example: {
      title: "Example SQL",
      versionScheme: "numeric",
      stable: [{ minimum: "1.0.0", maximum: "2.0.0" }],
      canary: [{ minimum: "3.0.0", maximum: "3.0.0" }],
      sources: [{ title: "Example releases", url: "https://example.com/releases" }],
    },
  },
  entries: [
    {
      id: "query.example",
      title: "Example query feature",
      category: "clause",
      scope: "application-query",
      owner: "repository",
      capability: "exampleFeature",
      coverage: ["ast:query.example"],
      documentation: ["docs/reference/example.md"],
      sources: [{ title: "Example specification", url: "https://example.com/sql" }],
      dialects: {
        example: {
          level: "exact",
          tests: ["packages/example/test/conformance.test.ts"],
        },
      },
    },
  ],
} as const satisfies GrammarFeatureLedger;

await describe("grammar feature ledger", async () => {
  await it("loads the canonical built-in inventory and maps every current capability once", async () => {
    const source = await readFile(new URL("../../../grammar/features/ledger.json", import.meta.url), "utf8");
    const ledger = parseGrammarFeatureLedger(JSON.parse(source) as unknown);
    strict.strictEqual(ledger.formatVersion, FEATURE_LEDGER_FORMAT_VERSION);
    strict.deepStrictEqual(Object.keys(ledger.dialects), ["mysql", "postgres", "sqlite"]);
    strict.deepStrictEqual(
      ledger.entries.flatMap(({ capability }) => (capability === undefined ? [] : [capability])),
      [
        "aggregateFilter",
        "arrays",
        "distinctOn",
        "fullJoins",
        "lockingReads",
        "setOperations",
        "recursiveCtes",
        "strictTables",
        "returning",
      ],
    );
    strict.strictEqual(featureSupport(ledger, "statement.dml.returning", "sqlite")?.introduced, "3.35.0");
    strict.strictEqual(featureSupport(ledger, "statement.dml.returning", "mysql")?.level, "unsupported");
    strict.strictEqual(featureSupport(ledger, "missing.feature", "sqlite"), undefined);
    strict.ok(Object.isFrozen(ledger));
    strict.ok(Object.isFrozen(ledger.entries));
    strict.ok(Object.isFrozen(ledger.entries[0]?.dialects.example ?? ledger.entries[0]?.dialects.mysql));
  });

  await it("validates and freezes public ledger definitions", () => {
    const ledger = defineGrammarFeatureLedger(minimal);
    strict.deepStrictEqual(ledger, minimal);
    strict.ok(Object.isFrozen(ledger.entries[0]?.sources[0]));
    strict.ok(Object.isFrozen(ledger.entries[0]?.dialects.example?.tests));
    strict.ok(Object.isFrozen(ledger.dialects.example?.stable));
  });

  await it("compares vendor versions and resolves introduction/removal windows", () => {
    strict.strictEqual(compareGrammarVersions("18.6", "18", "major"), 0);
    strict.strictEqual(compareGrammarVersions("9.7.2", "9.7", "major-minor"), 0);
    strict.strictEqual(compareGrammarVersions("3.53.4", "3.39.0", "numeric"), 1);
    strict.strictEqual(grammarVersionInRange("3.53.4", { minimum: "3.39.0", maximum: "3.53.4" }, "numeric"), true);

    const ledger = defineGrammarFeatureLedger({
      ...minimal,
      entries: [
        {
          ...minimal.entries[0],
          dialects: {
            example: {
              level: "exact",
              introduced: "1.1.0",
              removed: "2.0.0",
              tests: ["packages/example/test/conformance.test.ts"],
            },
          },
        },
      ],
    });
    strict.strictEqual(featureSupportAtVersion(ledger, "query.example", "example", "1.0.0"), undefined);
    strict.strictEqual(featureSupportAtVersion(ledger, "query.example", "example", "1.5.0")?.level, "exact");
    strict.strictEqual(featureSupportAtVersion(ledger, "query.example", "example", "2.0.0"), undefined);
  });

  await it("rejects ambiguous, unproven, unsorted, and misspelled data", () => {
    const invalid: readonly [unknown, RegExp][] = [
      [null, /must be an object/u],
      [{ ...minimal, formatVersion: 2 }, /Unsupported grammar feature ledger format/u],
      [{ ...minimal, typo: true }, /unknown properties: typo/u],
      [
        {
          ...minimal,
          dialects: {
            example: {
              ...minimal.dialects.example,
              stable: [{ minimum: "2.0.0", maximum: "1.0.0" }],
            },
          },
        },
        /minimum must not be newer/u,
      ],
      [{ ...minimal, entries: [{ ...minimal.entries[0], id: "Example" }] }, /canonical feature id/u],
      [
        {
          ...minimal,
          entries: [
            { ...minimal.entries[0], id: "query.z" },
            { ...minimal.entries[0], id: "query.a", capability: "otherFeature" },
          ],
        },
        /sorted by id/u,
      ],
      [{ ...minimal, entries: [minimal.entries[0], minimal.entries[0]] }, /unique feature ids/u],
      [
        {
          ...minimal,
          entries: [{ ...minimal.entries[0], sources: [{ title: "Insecure", url: "http://example.com" }] }],
        },
        /must use HTTPS/u,
      ],
      [
        {
          ...minimal,
          entries: [
            {
              ...minimal.entries[0],
              dialects: { example: { level: "exact", tests: [] } },
            },
          ],
        },
        /must prove the exact classification/u,
      ],
      [
        {
          ...minimal,
          entries: [
            {
              ...minimal.entries[0],
              dialects: { example: { level: "unsupported", tests: [] } },
            },
          ],
        },
        /diagnostic is required/u,
      ],
      [
        {
          ...minimal,
          entries: [
            {
              ...minimal.entries[0],
              dialects: {
                example: {
                  level: "exact",
                  tests: ["packages/z/test/z.test.ts", "packages/a/test/a.test.ts"],
                },
              },
            },
          ],
        },
        /tests must be sorted/u,
      ],
    ];
    for (const [value, message] of invalid) strict.throws(() => parseGrammarFeatureLedger(value), message);
  });
});
