# Authoring a SQL grammar

typed-sql grammars are ordinary packages that implement the public dialect contract. The compiler,
schema loader, CLI, and editor tooling do not contain a list of database engines. They discover SQL
semantics through the dialect selected in `typed-sql.config.ts`.

This guide uses only published package entrypoints. A grammar must not import files from another
typed-sql package's `src` or `dist` directory.

## Package boundary

A grammar package should:

- depend on `@typed-sql/core` for the query and dialect contracts;
- depend on `@typed-sql/schema` when it uses the shared snapshot parser;
- export `sql` from its package root;
- export a dialect factory and default type policy from the same root;
- keep database drivers outside normal dependencies;
- put optional introspection and execution adapters behind explicit subpath exports.

Applications should be able to install the grammar without installing a driver. If an adapter needs
one, load the application-owned package lazily and return an actionable installation error when it
is absent.

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
  // Tokenize, parse, and resolve with your package's own grammar. Use snapshot for catalog
  // resolution and return source-mapped columns, ordered parameters, and diagnostics.
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
    if (!Number.isInteger(index) || index < 1) throw new RangeError("parameter indexes start at 1");
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

The package root named by `sqlModule` must be the exact module from which applications import
`sql`. The compiler uses that string to find tagged templates without knowing the grammar's package
name.

## Contract responsibilities

`DialectPlugin` contract version 3 separates neutral compiler mechanics from SQL semantics:

- `placeholder(index)` defines one-based rendered parameter markers and rejects invalid indexes.
- `quoteIdentifier(identifier)` must match the grammar's runtime renderer exactly.
- `capabilities` is an immutable, grammar-owned map. Core exposes it but does not interpret its keys.
- `analyze(text, snapshot, policy)` returns result columns, ordered parameter evidence, and
  source-mapped diagnostics.
- `validateSnapshot(value)` owns dialect and grammar-version compatibility.
- `defaultTypePolicy` defines the grammar's default database-to-TypeScript mapping.

Return parameters in database placeholder order. When evidence is insufficient, use `unknown` for
that position. Unsupported, ambiguous, invalid, or version-gated SQL must produce a stable error
diagnostic or a conservative unknown result; it must never receive an optimistic type.

Core exports `ResolverSchemaIndex`, `ParameterCollector`, `unionTypeLiterals`, and `closestName` as
optional grammar-neutral resolver primitives. A grammar may use them without surrendering control
of its parser, identifiers, operators, functions, coercions, nullability, or diagnostics.

## Version compatibility

Three versions have different jobs:

- `DIALECT_CONTRACT_VERSION` is the typed-sql plugin protocol. `assertDialectPlugin` rejects a
  mismatched version before compilation.
- `grammarVersion` versions the grammar and snapshot semantics. Store it as `dialectVersion` in
  generated snapshots and reject unsupported snapshots in `validateSnapshot`.
- `formatVersion` versions the neutral snapshot envelope and is currently `1`.

Changing placeholder behavior, identifier rules, catalog interpretation, or inferred types should
change the grammar version whenever an old snapshot could be interpreted differently. An npm
package version is not a substitute for this explicit compatibility check.

## Conformance checklist

Before publishing, test the package through its public entrypoint and assert:

1. `assertDialectPlugin` and `defineConfig` accept the plugin.
2. Placeholder and identifier rendering match the runtime adapter.
3. A valid snapshot is accepted; another dialect and an incompatible `dialectVersion` are rejected.
4. One query proves exact result columns and an ordered parameter tuple.
5. A type-policy override changes inference and the matching runtime codec together.
6. Unsupported syntax emits the documented diagnostic and the compiler produces no typed query.
7. The packed tarball installs in an empty project without workspace imports or a database driver.

typed-sql applies this same harness to PostgreSQL, MySQL, and a synthetic external grammar. See
[`test/grammar/conformance.ts`](../test/grammar/conformance.ts) and the packed-consumer contract test
for executable examples.
