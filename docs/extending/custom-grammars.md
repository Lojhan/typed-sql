---
title: Author a custom SQL grammar
description: Implement a third-party typed-sql dialect through public grammar, schema, resolver, and adapter contracts.
---

# Author a custom SQL grammar

typed-sql grammars are ordinary packages that implement the public dialect contract. The compiler, schema loader, CLI, and editor tooling discover SQL semantics through the dialect selected in `typed-sql.config.ts`.

A grammar must use published package entrypoints. Do not import another typed-sql package's `src` or `dist` files.

## Package boundary

A grammar package should:

- depend on `@typed-sql/core` for query and dialect contracts;
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

const plugin = Object.freeze({
  contractVersion: DIALECT_CONTRACT_VERSION,
  id: "acme",
  grammarVersion: ACME_GRAMMAR_VERSION,
  sqlModule: "@acme/typed-sql",
  capabilities: Object.freeze({ returning: false, recursiveCtes: false }),
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
- `analyze(text, snapshot, policy)` returns columns, ordered parameter evidence, source-mapped diagnostics, and versioned `QuerySemantics`.
- `validateSnapshot(value)` owns dialect and grammar-version compatibility.
- `defaultTypePolicy` defines the default database-to-TypeScript mapping.

Return parameters in placeholder order. Use `unknown` when evidence is insufficient. Unsupported, ambiguous, invalid, or version-gated SQL must produce a diagnostic or conservative unknown result, never an optimistic type.

Core exports optional grammar-neutral helpers including `ResolverSchemaIndex`, `ParameterCollector`, `unionTypeLiterals`, and `closestName`. A grammar retains control of parsing, identifiers, operators, built-ins, coercions, nullability, and diagnostics.

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

`@typed-sql/conformance` is the executable compatibility contract for first- and third-party
grammars. Install it and Poku as development dependencies:

```sh
pnpm add -D @typed-sql/conformance poku
```

Export a `GrammarConformanceFixture` from the grammar package and run it in an ordinary Poku test:

```ts
import {
  assertGrammarConformance,
  defineGrammarConformanceFixture,
  GRAMMAR_CONFORMANCE_VERSION,
} from "@typed-sql/conformance";
import { describe, it } from "poku";
import { acme, acmeConformanceFixture } from "../src/index.js";

await describe("acme grammar", async () => {
  await it("implements the typed-sql grammar contract", () => {
    assertGrammarConformance(defineGrammarConformanceFixture({
      version: GRAMMAR_CONFORMANCE_VERSION,
      dialect: acme(),
      ...acmeConformanceFixture,
    }));
  });
});
```

The fixture proves:

- plugin, config, renderer, snapshot, and grammar-version compatibility;
- exact rows and ordered parameters for selects, nullability, joins, CTEs, functions, and DML;
- one positive or fail-closed probe for every declared capability;
- source-ranged diagnostics and deeply immutable semantic evidence;
- structural variants, fingerprints, type-policy overrides, and the absence of `any`;
- unsupported SQL fails closed in both direct analysis and compiler integration.

Capability declarations are claims, not hints. Set a capability to `true` only when its probe
resolves successfully and records the capability in semantic evidence. Set it to `false` when the
grammar deliberately rejects the feature, and provide the expected diagnostic. A grammar must
provide exactly one probe for every key it declares.

The required probe names and fixture shape are versioned by `GRAMMAR_CONFORMANCE_VERSION`. A new
optional assertion is additive. A change that invalidates an existing conforming fixture increments
the conformance version and ships through the matching typed-sql major version.

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
