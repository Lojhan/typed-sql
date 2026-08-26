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
  };
}

const plugin = Object.freeze({
  contractVersion: DIALECT_CONTRACT_VERSION,
  id: "acme",
  grammarVersion: ACME_GRAMMAR_VERSION,
  sqlModule: "@acme/typed-sql",
  capabilities: Object.freeze({ returning: false, recursiveCtes: true }),
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
- `analyze(text, snapshot, policy)` returns columns, ordered parameter evidence, and source-mapped diagnostics.
- `validateSnapshot(value)` owns dialect and grammar-version compatibility.
- `defaultTypePolicy` defines the default database-to-TypeScript mapping.

Return parameters in placeholder order. Use `unknown` when evidence is insufficient. Unsupported, ambiguous, invalid, or version-gated SQL must produce a diagnostic or conservative unknown result, never an optimistic type.

Core exports optional grammar-neutral helpers including `ResolverSchemaIndex`, `ParameterCollector`, `unionTypeLiterals`, and `closestName`. A grammar retains control of parsing, identifiers, operators, built-ins, coercions, nullability, and diagnostics.

## Compatibility versions

Three versions have different responsibilities:

- `DIALECT_CONTRACT_VERSION` identifies the typed-sql plugin protocol.
- `grammarVersion` identifies grammar and snapshot semantics.
- `formatVersion` identifies the neutral snapshot envelope.

Changing placeholder behavior, identifier rules, catalog interpretation, or inferred types requires a grammar-version change whenever an existing snapshot could be interpreted differently. The package version does not replace this explicit check.

## Conformance checklist

Before publishing a grammar:

1. Verify `assertDialectPlugin` and `defineConfig` accept it.
2. Verify placeholder and identifier rendering match the runtime adapter.
3. Accept valid snapshots and reject other dialects or incompatible grammar versions.
4. Prove one exact row and ordered parameter tuple.
5. Prove a type-policy override changes inference and runtime decoding together.
6. Produce a documented diagnostic for unsupported syntax.
7. Install the packed package in an empty project without workspace imports or a database driver.

Executable conformance examples live in the repository's [`test/grammar`](https://github.com/Lojhan/typed-sql/tree/main/test/grammar) fixtures.
