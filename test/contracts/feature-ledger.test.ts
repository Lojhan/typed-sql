import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { renderFeatureLedgerDocumentation } from "../../packages/conformance/src/feature-ledger-markdown.js";
import { parseGrammarFeatureLedger } from "../../packages/conformance/src/index.js";
import {
  type DialectPlugin,
  diagnosticRegistry,
  type SchemaSnapshot,
  UnsupportedAdapterCapabilityError,
  UnsupportedExecutionCapabilityError,
} from "../../packages/core/src/index.js";
import { mysql } from "../../packages/mysql/src/index.js";
import { postgres } from "../../packages/postgres/src/index.js";
import { sqlite } from "../../packages/sqlite/src/index.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const requiredOwnedSurfaces = [
  "ast:lexical.comments",
  "ast:lexical.identifiers",
  "ast:lexical.numbers",
  "ast:lexical.parameters",
  "ast:lexical.strings",
  "diagnostic:command.out-of-scope",
  "diagnostic:core.registry",
  "resolver:mysql.catalog",
  "resolver:mysql.coercion",
  "resolver:mysql.function-catalog",
  "resolver:mysql.nullability",
  "resolver:mysql.operator-catalog",
  "resolver:mysql.semantics",
  "resolver:postgres.catalog",
  "resolver:postgres.coercion",
  "resolver:postgres.function-catalog",
  "resolver:postgres.nullability",
  "resolver:postgres.operator-catalog",
  "resolver:postgres.semantics",
  "resolver:sqlite.catalog",
  "resolver:sqlite.coercion",
  "resolver:sqlite.function-catalog",
  "resolver:sqlite.nullability",
  "resolver:sqlite.operator-catalog",
  "resolver:sqlite.semantics",
  "runtime:mysql.batch",
  "runtime:mysql.buffered",
  "runtime:mysql.bulk-load",
  "runtime:mysql.cancellation",
  "runtime:mysql.decoding",
  "runtime:mysql.live-verification",
  "runtime:mysql.plan-inspection",
  "runtime:mysql.prepared",
  "runtime:mysql.streaming",
  "runtime:mysql.transaction",
  "runtime:postgres.batch",
  "runtime:postgres.buffered",
  "runtime:postgres.cancellation",
  "runtime:postgres.copy",
  "runtime:postgres.decoding",
  "runtime:postgres.live-verification",
  "runtime:postgres.pipeline",
  "runtime:postgres.plan-inspection",
  "runtime:postgres.prepared",
  "runtime:postgres.streaming",
  "runtime:postgres.transaction",
  "runtime:sqlite.batch",
  "runtime:sqlite.buffered",
  "runtime:sqlite.cancellation",
  "runtime:sqlite.decoding",
  "runtime:sqlite.live-verification",
  "runtime:sqlite.plan-inspection",
  "runtime:sqlite.prepared",
  "runtime:sqlite.streaming",
  "runtime:sqlite.transaction",
  "schema:mysql.introspection",
  "schema:postgres.introspection",
  "schema:sqlite.introspection",
  "tooling:compiler.extraction",
  "tooling:compiler.manifest",
  "tooling:compiler.types",
  "tooling:diagnostics.ranges",
  "tooling:editor.language-server",
  "tooling:parser.bounded-work",
  "tooling:sql.fragment",
  "tooling:sql.ident",
  "tooling:sql.raw",
  "tooling:typescript.preview-bridge",
] as const;

const grammars: readonly {
  readonly dialect: DialectPlugin;
  readonly snapshot: SchemaSnapshot;
}[] = [
  {
    dialect: mysql(),
    snapshot: {
      formatVersion: 1,
      dialect: "mysql",
      version: "8.4.6",
      server: { product: "mysql", version: "8.4.6", versionKey: "8.4.6", features: [], settings: {} },
      tables: {},
    },
  },
  {
    dialect: postgres(),
    snapshot: {
      formatVersion: 1,
      dialect: "postgres",
      version: "18.6",
      server: { product: "postgres", version: "18.6", versionKey: "18", features: [], settings: {} },
      tables: {},
    },
  },
  {
    dialect: sqlite(),
    snapshot: {
      formatVersion: 1,
      dialect: "sqlite",
      version: "3.53.0",
      server: { product: "sqlite", version: "3.53.0", versionKey: "3.53.0", features: [], settings: {} },
      tables: {},
    },
  },
];

await describe("grammar feature ledger contract", async () => {
  const ledger = parseGrammarFeatureLedger(
    JSON.parse(await readFile(resolve(workspace, "grammar/features/ledger.json"), "utf8")) as unknown,
  );

  await it("classifies every capability declared by every built-in grammar", () => {
    for (const { dialect, snapshot } of grammars) {
      const entries = ledger.entries.filter(
        ({ capability }) => capability !== undefined && capability in dialect.capabilities,
      );
      const byCapability = new Map(entries.map((entry) => [entry.capability, entry]));
      strict.deepStrictEqual(
        [...byCapability.keys()].sort(),
        Object.keys(dialect.capabilities).sort(),
        `${dialect.id} ledger capabilities`,
      );
      const states = dialect.resolveCapabilities?.(snapshot);
      if (states === undefined) throw new Error(`${dialect.id} must resolve versioned capability states`);
      for (const [capability, declared] of Object.entries(dialect.capabilities)) {
        const support = byCapability.get(capability)?.dialects[dialect.id];
        if (support === undefined) throw new Error(`${dialect.id}.${capability} is unclassified`);
        strict.strictEqual(
          declared,
          support.level === "exact" || support.level === "conservative",
          `${dialect.id}.${capability} boolean compatibility view`,
        );
        strict.strictEqual(
          states[capability]?.level === "unsupported",
          support.level === "unsupported",
          `${dialect.id}.${capability} current support state`,
        );
      }
    }
  });

  await it("references repository tests that exist", async () => {
    const diagnosticCodes = new Set([
      ...Object.keys(diagnosticRegistry),
      new UnsupportedAdapterCapabilityError("contract.test").code,
      new UnsupportedExecutionCapabilityError("cancellation").code,
    ]);
    for (const entry of ledger.entries) {
      for (const [dialect, support] of Object.entries(entry.dialects)) {
        if (support.diagnostic !== undefined) {
          strict.ok(diagnosticCodes.has(support.diagnostic), `${entry.id}.${dialect} uses a registered diagnostic`);
        }
        for (const test of support.tests) {
          const path = test.split("#", 1)[0]!;
          await strict.doesNotReject(access(resolve(workspace, path)), `${entry.id}.${dialect} references ${path}`);
        }
      }
    }
  });

  await it("classifies every exported AST node and links every public support page", async () => {
    const astTypes = await readFile(resolve(workspace, "packages/ast/src/compat/types.ts"), "utf8");
    const astNodes = [...astTypes.matchAll(/^export interface ([A-Z][A-Za-z0-9]*)/gmu)].map(
      ([, name]) => `ast:node.${name!.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase()}`,
    );
    const coverage = new Set(ledger.entries.flatMap((entry) => entry.coverage));
    strict.deepStrictEqual(
      astNodes.filter((token) => !coverage.has(token)),
      [],
      "every public AST interface needs one feature-ledger owner",
    );
    strict.deepStrictEqual(
      requiredOwnedSurfaces.filter((token) => !coverage.has(token)),
      [],
      "every current resolver, runtime, schema, and tooling surface needs one feature-ledger owner",
    );

    for (const entry of ledger.entries) {
      for (const page of entry.documentation) {
        await strict.doesNotReject(access(resolve(workspace, page)), `${entry.id} documents ${page}`);
      }
    }
  });

  await it("keeps the generated public support matrix synchronized", async () => {
    strict.strictEqual(
      await readFile(resolve(workspace, "docs/reference/grammar-support.md"), "utf8"),
      renderFeatureLedgerDocumentation(ledger),
    );
  });

  await it("has no unclassified stable or canary target", () => {
    for (const entry of ledger.entries) {
      for (const [dialect, policy] of Object.entries(ledger.dialects)) {
        const support = entry.dialects[dialect];
        if (support === undefined) throw new Error(`${entry.id}.${dialect} is unclassified`);
        for (const range of [...policy.stable, ...policy.canary]) {
          if (support.introduced !== undefined) {
            // A target older than introduction is explicitly outside the feature's availability window.
            strict.ok(typeof support.introduced === "string");
          }
          strict.ok(range.minimum.length > 0 && range.maximum.length > 0);
        }
      }
    }
  });
});
