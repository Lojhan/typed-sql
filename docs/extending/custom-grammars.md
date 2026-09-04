---
title: Author a custom SQL grammar
pageType: how-to
description: Implement a third-party typed-sql dialect through public grammar, schema, resolver, and adapter contracts.
---

# Author a custom SQL grammar

typed-sql grammars are ordinary packages that implement the public dialect contract. The compiler, schema loader, CLI, and editor tooling discover SQL semantics through the dialect selected in `typed-sql.config.ts`.

A grammar must use published package entrypoints. Do not import another typed-sql package's `src` or `dist` files.

## Package boundary

A grammar package should:

- depend on `@typed-sql/core` for query and dialect contracts;
- depend on `@typed-sql/ast` when it reuses the neutral tokenizer and bounded cursor toolkit;
- depend on `@typed-sql/schema` when it uses the shared snapshot parser;
- export `sql`, its dialect factory, and its default type policy from the package root;
- keep database drivers outside normal dependencies;
- place optional introspection and execution adapters behind explicit subpath exports.

Installing the grammar must not install a driver. Driver adapters load the application dependency lazily and return an actionable installation error when it is absent.

## Minimal implementation

```ts
import {
  DIALECT_CONTRACT_VERSION,
  assertDialectPlugin,
  defineDialectCapabilityStates,
  sql,
  type DialectAnalysis,
  type DialectPlugin,
  type SchemaSnapshot,
  unknownQuerySemantics,
} from "@typed-sql/core";
import { parseSchemaSnapshot } from "@typed-sql/schema";

export { sql };

export interface AcmeTypePolicy {
  readonly scalar: "number" | "string";
}

export const typePolicy: AcmeTypePolicy = Object.freeze({ scalar: "number" });
export const ACME_GRAMMAR_VERSION = "1.0.0";

export type AcmeSnapshot = SchemaSnapshot & { readonly dialect: "acme" };

function validateSnapshot(value: unknown): AcmeSnapshot {
  const snapshot = parseSchemaSnapshot(value);
  if (snapshot.dialect !== "acme") {
    throw new TypeError(`acme cannot use a ${snapshot.dialect} schema snapshot`);
  }
  if (snapshot.dialectVersion !== ACME_GRAMMAR_VERSION) {
    throw new TypeError(
      `acme grammar ${ACME_GRAMMAR_VERSION} cannot use snapshot ${snapshot.dialectVersion}`,
    );
  }
  return snapshot as AcmeSnapshot;
}

function analyze(
  text: string,
  snapshot: AcmeSnapshot,
  policy: AcmeTypePolicy,
): DialectAnalysis {
  void text;
  void snapshot;
  void policy;

  return {
    columns: [],
    parameters: [],
    diagnostics: [],
    semantics: unknownQuerySemantics(
      { start: 0, end: text.length, line: 1, column: 1 },
      "The example grammar has not implemented semantic analysis.",
    ),
  };
}

function resolveCapabilities(snapshot: AcmeSnapshot) {
  const evidence = [
    { kind: "grammar" as const, key: "grammarVersion", value: ACME_GRAMMAR_VERSION },
    ...(snapshot.server === undefined
      ? []
      : [{ kind: "server-version" as const, key: snapshot.server.product, value: snapshot.server.versionKey }]),
  ];
  return defineDialectCapabilityStates({
    recursiveCtes: {
      level: "unsupported",
      reason: "Recursive CTE analysis is not implemented.",
      diagnostic: "ACME401",
      evidence,
    },
    returning: {
      level: "unsupported",
      reason: "RETURNING is not part of the Acme grammar.",
      diagnostic: "ACME401",
      evidence,
    },
  });
}

const plugin = Object.freeze({
  contractVersion: DIALECT_CONTRACT_VERSION,
  id: "acme",
  grammarVersion: ACME_GRAMMAR_VERSION,
  sqlModule: "@acme/typed-sql",
  capabilities: Object.freeze({ recursiveCtes: false, returning: false }),
  resolveCapabilities,
  defaultTypePolicy: typePolicy,
  placeholder(index: number) {
    if (!Number.isInteger(index) || index < 1) {
      throw new RangeError("parameter indexes start at 1");
    }
    return `?${index}`;
  },
  quoteIdentifier(identifier: string) {
    return `[${identifier.replaceAll("]", "]]")}]`;
  },
  analyze(text: string, snapshot: AcmeSnapshot, policy = typePolicy) {
    return analyze(text, snapshot, policy);
  },
  validateSnapshot,
}) satisfies DialectPlugin<AcmeSnapshot, AcmeTypePolicy>;

assertDialectPlugin(plugin);

export function acme(): DialectPlugin<AcmeSnapshot, AcmeTypePolicy> {
  return plugin;
}
```

The `quoteIdentifier` implementation above doubles closing brackets. Adapt it to the exact quoting rules of the target database.

The module named by `sqlModule` must be the package entrypoint from which applications import `sql`. The compiler uses that string to identify tagged templates without knowing the package name.

## Contract responsibilities

The dialect contract separates neutral compiler mechanics from SQL semantics:

- `placeholder(index)` renders one-based parameter markers.
- `quoteIdentifier(identifier)` matches the runtime renderer.
- `capabilities` is an immutable, grammar-owned feature map.
- `resolveCapabilities(snapshot, policy?)` maps every declared key to a deterministic, evidence-backed state.
- `analyze(text, snapshot, policy)` returns columns, ordered parameter evidence, source-mapped diagnostics, and versioned `QuerySemantics`.
- `validateSnapshot(value)` owns dialect and grammar-version compatibility.
- `defaultTypePolicy` defines the default database-to-TypeScript mapping.

Return parameters in placeholder order. Use `unknown` when evidence is insufficient. Unsupported, ambiguous, invalid, or version-gated SQL must produce a diagnostic or conservative unknown result, never an optimistic type.

Core exports optional grammar-neutral helpers including `ResolverSchemaIndex`, `ParameterCollector`, `unionTypeLiterals`, and `closestName`. A grammar retains control of parsing, identifiers, operators, built-ins, coercions, nullability, and diagnostics.

## Parser toolkit

`@typed-sql/ast/toolkit` supplies mechanics without selecting a SQL grammar. Define and cache one immutable lexical
profile for each grammar/version mode, then build grammar-owned productions over `TokenCursor`:

```ts
import {
  defineSqlLexicalProfile,
  TokenCursor,
  tokenizeSql,
} from "@typed-sql/ast/toolkit";

const lexicalProfile = defineSqlLexicalProfile({
  keywords: new Set(["FROM", "SELECT"]),
  operators: ["=", "+", "*"],
  identifierQuotes: [{ open: "[", close: "]", escape: "double-close" }],
  stringModes: [{ prefix: "", quote: "'" }],
  parameterModes: [{ kind: "numbered-question", startAt: 1 }],
});

function parseSelect(text: string) {
  const cursor = new TokenCursor(tokenizeSql(text, lexicalProfile));
  cursor.expect("SELECT");
  const column = cursor.identifier();
  cursor.expect("FROM");
  const table = cursor.identifier();
  cursor.expectKind("eof");
  return Object.freeze({ kind: "select" as const, column, table });
}
```

`SQL_PARSER_TOOLKIT_VERSION` identifies this public mechanics contract. The toolkit enforces bounded SQL length, token count, and parse depth and reports `SqlToolkitError` with stable source
ranges. It also exports delimited-list cursor mechanics, precedence-table validation, range merging, and a generic
cycle-safe tree walker. It does not provide statement productions, built-ins, coercions, nullability, or version
decisions; those remain in the grammar package.

The package-root `parseStatement`, `parseSelect`, `tokenize`, compatibility AST types, and `walkStatement` exports are
deprecated 2.x migration aids. They combine historical first-party syntax modes and are removed in typed-sql 3.0.
Do not use them in a new grammar.

Semantic metadata records the operation, referenced objects, result cardinality, volatility, locking, connection affinity, and required capabilities. Every positive safety classification needs syntax or schema evidence. Dependencies must say whether they are schema-resolved or only syntactic. If the grammar cannot support a statement or establish its effects, return `unknownQuerySemantics()` and a diagnostic where the SQL itself is unsupported. Do not infer safety from a statement prefix or regular expression.

Use `defineQuerySemantics()` to canonicalize and deeply freeze successful grammar evidence. Structural variants are analyzed as complete statements. The compiler maps their semantic ranges back to TypeScript and merges the possible results conservatively through `mergeQuerySemantics()`.

## Compatibility versions

Three versions have different responsibilities:

- `DIALECT_CONTRACT_VERSION` identifies the typed-sql plugin protocol.
- `grammarVersion` identifies grammar and snapshot semantics.
- `formatVersion` identifies the neutral snapshot envelope.

Changing placeholder behavior, identifier rules, catalog interpretation, or inferred types requires a grammar-version change whenever an existing snapshot could be interpreted differently. The package version does not replace this explicit check.

For the dialect v3 to v4 semantic boundary and its fail-closed migration path, see
[Upgrade from typed-sql v1](../guides/upgrading-from-v1.md#upgrade-a-custom-grammar).

## Conformance kit

`@typed-sql/conformance/v2` is the executable, feature-addressable compatibility contract for
first- and third-party grammars. Install the package and your test runner as development dependencies:

```sh
pnpm add -D @typed-sql/conformance poku
```

Define permanent probes and run the relevant evidence layers in an ordinary Poku test:

```ts
import {
  CONFORMANCE_VERSION,
  createConformanceReport,
  defineConformanceSuite,
  runStaticConformanceProbe,
} from "@typed-sql/conformance/v2";
import { describe, it } from "poku";
import { acme, acmeParser, acmeRenderer, snapshot } from "../src/index.js";

await describe("acme grammar", async () => {
  await it("implements the typed-sql grammar contract", async () => {
    const suite = defineConformanceSuite({
      version: CONFORMANCE_VERSION,
      name: "acme",
      probes: [selectProbe],
    });
    const results = suite.probes.map((probe) => runStaticConformanceProbe(probe, target, {
      dialect: acme(),
      snapshot,
      renderer: acmeRenderer,
      parse: acmeParser,
    }));
    createConformanceReport("acme", environment, results);
  });
});
```

Each v2 probe names a support-ledger feature and can prove:

- lex/parse acceptance, immutable AST evidence, and source-ranged diagnostics;
- resolved rows, nullability, complete ordered parameters, and fail-closed behavior;
- compiler row/parameter declarations and stable query fingerprints;
- rendered SQL and parameter order without persisting parameter values;
- prepare metadata, decoded execution values, and normalized plans when a live adapter supports them.

Expected outcomes select exact grammar/database versions or bounded database ranges plus capability
evidence. A layer may be skipped only with a registered reason. `assertExactConformance()` rejects an
exact result if any layer failed, skipped, or was quarantined.

Capability declarations are claims, not hints. Set a capability to `true` only when its probe
resolves successfully and records the capability in semantic evidence. Set it to `false` when the
grammar deliberately rejects the feature, and provide the expected diagnostic. A grammar must
provide exactly one probe for every key it declares.

Use `assertVersionedCapabilityConformance()` for the boundary immediately before a feature, the
introduction version, the current supported version, and every setting, extension, or compile-option
condition. The assertion resolves each probe twice and verifies deterministic, deeply frozen evidence
without teaching the conformance package vendor version rules.

Probe IDs are permanent once released. `featureId` must resolve to the canonical feature ledger, and
reports record grammar, database, driver, runtime, TypeScript, schema, and capability evidence.

The package-root v1 fixture contract remains available during typed-sql 2.x. Existing grammars can
run `runAdaptedGrammarConformanceV1()` from the v2 subpath while they add native v2 probes. Adapted
missing layers remain explicit skips and do not count as exact. typed-sql 3.0 removes the v1 API.

### Codecs and performance

Use `assertCodecConformance()` to keep representative runtime decoding cases beside static type
policy probes. Use `measureGrammarPerformance()` to measure complete analysis batches after warmup:

```ts
const result = measureGrammarPerformance({
  dialect: acme(),
  snapshot,
  queries: corpus,
  warmups: 5,
  samples: 30,
});
```

The result reports p50, p95, and minimum queries per second. Compare results on a pinned runner and
store that environment's budget in the grammar repository. The kit intentionally has no universal
timing threshold because machine-independent millisecond budgets are misleading.

Before publishing, pack the grammar and run its conformance suite from an empty consumer project.
This catches private source imports, missing exports, undeclared dependencies, and accidental driver
installation. The repository's
[`examples/synthetic-grammar`](https://github.com/Lojhan/typed-sql/tree/main/examples/synthetic-grammar)
is a minimal grammar that passes using published entrypoints only.
