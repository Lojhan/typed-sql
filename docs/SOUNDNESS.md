# Inference soundness policy

typed-sql's primary correctness rule is fail closed: a query may produce an exact type, a
conservative `unknown`, or a stable diagnostic. It must never produce a plausible but confidently
incorrect row or ordered parameter type.

## Classification

Every soundness-corpus case has one of three outcomes:

- **Exact:** the complete row type, parameter tuple, result kind, and relevant nullability are known
  and asserted exactly.
- **Unknown:** analysis has insufficient evidence, so the uncertain row property or parameter
  position is `unknown`. Warnings may explain the boundary, but `any` is forbidden.
- **Diagnostic:** invalid, ambiguous, conflicting, stale, malformed, or unsupported SQL produces a
  stable error code. The compiler emits no confident query overlay for that statement.

A confidently incorrect inference is a release blocker. A conservative `unknown` is not a
correctness defect, although expanding supported inference can still be a feature. Diagnostic
message prose may improve without a major release; automation depends on codes and mapped ranges.

## Corpus layers

[`test/soundness/corpus.ts`](../test/soundness/corpus.ts) is the shared PostgreSQL/MySQL grammar
matrix. It covers selects, aliases, joins and nullability, CTEs, correlated subqueries, aggregates,
windows, catalog functions, casts, enums, DML results and commands, ordered and unconstrained
parameters, stale schemas, ambiguous and duplicate output columns, unsupported dialect syntax, and
malformed SQL.

[`test/soundness/source-corpus.ts`](../test/soundness/source-corpus.ts) exercises ordinary
TypeScript source. It covers exact row and parameter overlays, conditional projections and filters,
fragment diagnostic mapping, incompatible structural parameter contexts, malformed fragments, and
the deliberate `sql.dynamic()` escape to `Query<unknown>`.

Thin Poku runners execute those same expectations through:

- the PostgreSQL and MySQL grammar packages;
- the grammar-neutral compiler;
- the `typed-sql check` CLI process, including TypeScript 7 validation;
- the TypeScript bridge and its transformed overlay;
- the editor-facing language service, including hover and diagnostic ranges.

The package `test` commands include their soundness files, so protected `pnpm verify` runs the
corpus. Run only this gate with:

```sh
pnpm test:soundness
```

Each participating package also owns a direct command, for example:

```sh
pnpm --filter @typed-sql/postgres test:soundness
pnpm --filter @typed-sql/mysql test:soundness
pnpm --filter @typed-sql/compiler test:soundness
```

## Regression rule

Every beta, RC, or stable correctness fix must add the smallest case that reproduces the defect.
Use the raw SQL corpus when the behavior belongs to a grammar. Use the source corpus when it depends
on template extraction, fragments, conditional structure, overlay generation, CLI behavior, or
editor mapping. If the grammars intentionally differ, record both outcomes in the shared case.

The regression must assert the former unsafe outcome cannot return: exact cases freeze the whole
contract; unknown cases assert the uncertain position; diagnostic cases assert the code, severity,
absence of a query overlay, and an original-source range.
