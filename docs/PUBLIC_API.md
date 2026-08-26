# Public API and stability boundary

This document records the API boundary intended for typed-sql 1.0. It is a compatibility contract,
not an inventory of every internal source module. Package entrypoints, executable names, release
tracks, runtime exports, and the type relationships below are enforced by contract tests.

## Release tracks

The stable 1.0 train contains:

- `@typed-sql/core`
- `@typed-sql/ast`
- `@typed-sql/schema`
- `@typed-sql/config`
- `@typed-sql/compiler`
- `@typed-sql/postgres`
- `@typed-sql/mysql`
- `@typed-sql/cli`

`@typed-sql/ts-bridge` and `@typed-sql/language-server` remain experimental because they depend on
the pinned TypeScript 7.1 preview API. They continue on prerelease versions under `next` when the
stable packages move to `1.0.0` under `latest`. The private VS Code extension and Zed integration are
also experimental until their external installation and upgrade paths pass the editor reliability
gate.

`release-manifest.json` is the machine-readable source of truth. Every public package repeats its
track in `typedSql.releaseTrack`, so packed artifacts retain the classification. Stable release
assertions reject experimental packages in the stable publication set.

## Stable entrypoints

| Package | Public entrypoints |
| --- | --- |
| `@typed-sql/core` | package root |
| `@typed-sql/ast` | package root |
| `@typed-sql/schema` | package root |
| `@typed-sql/config` | package root |
| `@typed-sql/compiler` | package root |
| `@typed-sql/postgres` | package root, `/runtime`, `/pg` |
| `@typed-sql/mysql` | package root, `/runtime`, `/mysql2` |
| `@typed-sql/cli` | `typed-sql` executable; no JavaScript module entrypoint |

Application queries import `sql` from the selected dialect root. Driver-neutral applications and
grammar authors may import contracts from `@typed-sql/core`. Generated folders contain schema
metadata only and are not application API entrypoints.

## Query contract

The stable generic order is `Query<Row, Parameters>` and `SqlFragment<Parameters>`.

- `Row` is the result of the complete analyzed statement.
- `Parameters` is an ordered readonly tuple matching flattened interpolation order.
- `QueryRow<QueryValue>` and `QueryParameters<QueryValue>` extract those positions.
- `Query` is invariant in both positions so a query cannot be silently widened into a different row
  or parameter contract.
- `Database.execute(query)` returns `Promise<readonly Row[]>` and never changes the inferred row.
- `sql.fragment`, `sql.empty`, `sql.append`, `sql.where`, `sql.and`, `sql.or`, and `sql.join` preserve
  immutable segments and ordered parameter types.
- `undefined`, `null`, and `false` are the only absent values accepted by optional fragment
  composition.
- `sql.ident` quotes an identifier, `sql.value` creates an explicit value fragment, and `sql.raw`
  is a trusted static escape hatch rather than an escaping API.
- `sql.dynamic` deliberately returns `Query<unknown>`.

The compiler uses a reserved `sql.__typed` overlay protocol to ask TypeScript to validate the row
and complete parameter tuple. It is present in declarations because transformed consumer programs
must typecheck, but it is internal and unsupported for application calls. Applications use the
ordinary `sql` tag.

## Compiler contract

The stable package-root compiler surface is intentionally small:

- `checkFile` and its option/result types;
- `compileSource` and its option/result/query/fragment types;
- `extractStaticQueries`, `mapSqlRange`, `ExtractedQuery`, and `ExtractedInterpolation` for build-tool
  integrations.

Scanner control flow, append extraction, structural operand parsing, branch expansion, and
conditional row rendering remain internal implementation details. They can evolve without becoming
a second public compiler framework.

## Grammar-author contract

`@typed-sql/core` exposes `DialectPlugin`, `DialectCapabilities`, `SchemaProvider`, snapshot and
resolution types, `DIALECT_CONTRACT_VERSION`, `assertDialectPlugin`, `ResolverSchemaIndex`,
`ParameterCollector`, `unionTypeLiterals`, and `closestName`. These are grammar-neutral mechanisms.
Contract version 3 requires grammar-owned capabilities, parameter rendering, identifier quoting,
snapshot validation, and analysis of both result columns and ordered parameters. SQL parsing rules,
identifiers, operators, built-ins, nullability, catalog behavior, type policies, and unsupported
syntax belong to each grammar package.

The compiler discovers application tags through the plugin's exact `sqlModule` entrypoint. The
schema layer accepts any non-empty dialect id; compatibility belongs to the plugin's
`validateSnapshot` implementation. See [Authoring a SQL grammar](./GRAMMAR_AUTHORING.md) for a
public-entrypoint-only implementation and conformance checklist.

PostgreSQL and MySQL expose their configured dialect, schema provider/introspection contract,
default type policy, type mapping, and root `sql` tag. Runtime codecs are isolated under `/runtime`;
application-owned driver loading and adapters are isolated under `/pg` and `/mysql2`.

## Failure contract

- Unsupported, dynamic, invalid, ambiguous, or insufficiently proven SQL produces a diagnostic or
  `unknown`, never `any` or a guessed type.
- Confidently incorrect inference is a release-blocking correctness defect.
- Parameter values remain driver parameters unless the developer deliberately uses a structural
  API such as `sql.ident` or trusted `sql.raw`.
- A nested JavaScript template is not SQL structure by itself. Conditional structural branches must
  use `sql.fragment`; `TSQ004` and its editor quick fix preserve that explicit trust boundary.
- Static types depend on the generated snapshot and configured driver codec policy. They do not
  replace runtime validation at external trust boundaries.
- Conditional structural analysis is finite and bounded by `compiler.maxStructuralVariants`.

The release-blocking classification and cross-surface regression rules are defined in the
[inference soundness policy](./SOUNDNESS.md).

Diagnostic codes become stable at 1.0. Automation should depend on the exported code and registry,
not English message text. A diagnostic may include a structured `SqlDiagnosticFix`; editor tooling
validates its source offsets and maps it to the client's native edit format without parsing prose.

## Compatibility policy

Removing or incompatibly changing a stable entrypoint, runtime export, documented type
relationship, grammar contract version, or diagnostic meaning requires a major version. Additive
exports may ship in a minor version. Experimental packages can change while prerelease, but every
matching core/compiler/bridge release must remain internally compatible.
