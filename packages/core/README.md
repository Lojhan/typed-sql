# @typed-sql/core

The driver- and dialect-neutral foundation of [typed-sql](https://github.com/Lojhan/typed-sql).
It owns the `sql` tagged template, `Query<Row, Parameters>`, safe query fragments, rendering contract, database
adapter contract, diagnostics, and the interface implemented by every SQL grammar.

Most applications install it alongside one dialect:

```sh
pnpm add @typed-sql/core@next @typed-sql/postgres@next pg
```

Application queries import `sql` from the dialect root so tooling can associate the query with the
correct grammar:

```ts
import { sql } from "@typed-sql/postgres";

const query = sql`
  SELECT account.id, account.email
  FROM accounts AS account
  WHERE account.id = ${42n}
`;
```

The compiler supplies the ordered parameter tuple from SQL context. For example, comparing an
interpolation with a `bigint` column produces `Query<Row, readonly [bigint]>`, so passing a `string`
is a normal TypeScript error. Positions that cannot be proven remain `unknown`.

For optional runtime filters, infer a static base query and compose predicates without concatenating
values into SQL:

```ts
import { sql } from "@typed-sql/postgres";
import type { QueryRow } from "@typed-sql/core";

const base = sql`SELECT account.id, account.status FROM accounts AS account`;
type Account = QueryRow<typeof base>;

function filtered(status: Account["status"] | null, minimumId: Account["id"] | null) {
  const predicates = [
    status == null ? undefined : sql.fragment`account.status = ${status}`,
    minimumId == null ? undefined : sql.fragment`account.id >= ${minimumId}`,
  ] as const;
  return sql.where(base, sql.and(predicates));
}
```

`sql.and()` and `sql.or()` accept nullable fragment tuples, preserve parameter order, parenthesize
each predicate, and render `TRUE` when every predicate is absent. `sql.where()` preserves the base
row and concatenates its parameter tuple with the fragment tuple. This is a safe parameterization
and type-composition boundary; arbitrary dynamic SQL strings are intentionally not analyzed.

`sql.append()` provides the type-safe equivalent of conditionally appending clauses:

```ts
function filtered2(filters: { status?: Account["status"] | null; minimumId?: Account["id"] | null }) {
  const query = sql`SELECT account.id, account.status FROM accounts AS account`;
  return sql.append(
    query,
    sql.fragment` WHERE 1 = 1`,
    filters.status == null ? undefined : sql.fragment` AND account.status = ${filters.status}`,
    filters.minimumId == null ? undefined : sql.fragment` AND account.id >= ${filters.minimumId}`,
  );
}
```

JavaScript does not support operator overloading, so `query += fragment` would stringify the values
and erase their type and parameter segments. `sql.append()` skips `undefined`, `null`, and `false`,
then concatenates only validated fragments. Variadic arguments retain exact parameter order;
mutable fragment arrays can be spread and retain their allowed parameter union, but have a
variable-length parameter array.

When direct variadic fragments are visible to the typed-sql compiler, it analyzes them cumulatively
with the static base. The grammar therefore supplies each interpolation's expected column type;
the core runtime alone only owns immutable composition and parameterization.

`sql.empty` enables SQL-template-native conditional structure:

```ts
const query = sql`
  SELECT account.id, account.email
    ${select.status ? sql.fragment`, account.status` : sql.empty}
  FROM accounts AS account
`;
```

The runtime only flattens fragment segments and values. The compiler analyzes every finite branch as
a complete statement and supplies the branch-dependent row type; no clause-builder abstraction is
introduced. Structural compilation defaults to at most 64 correlated variants and fails with
`TSQ003` before invoking a grammar if independent conditions exceed that bound.

`sql.join()` accepts only `SqlFragment` values. Its optional separator is also a trusted fragment,
so use `sql.raw(" UNION ALL ")` when a non-comma separator is intentional; an arbitrary runtime
string is never promoted to SQL implicitly.

`@typed-sql/core` is directly useful to grammar and adapter authors:

```ts
import {
  DIALECT_CONTRACT_VERSION,
  assertDialectPlugin,
  createDatabase,
  defineConfig,
  closestName,
  ParameterCollector,
  renderQuery,
  parameterTypeLiteral,
  ResolverSchemaIndex,
  rowTypeLiteral,
  sql,
  unionTypeLiterals,
  type DialectPlugin,
  type DialectCapabilities,
  type Query,
  type QueryParameters,
  type QueryRow,
  type SqlFragment,
  type SchemaSnapshot,
} from "@typed-sql/core";
```

`ResolverSchemaIndex`, `ParameterCollector`, `unionTypeLiterals`, and `closestName` are reusable,
dialect-neutral resolver primitives. Future PostgreSQL, MySQL, MSSQL, SQLite, and third-party
grammars can share indexed catalog lookup and conservative parameter merging while keeping SQL
semantics, built-ins, quoting, type policy, and unsupported syntax inside their own package.

The package has no database, parser, grammar, driver, TypeScript compiler, or editor dependency.
See the [architecture contract](https://github.com/Lojhan/typed-sql/blob/main/docs/ARCHITECTURE.md)
and [grammar authoring guide](https://github.com/Lojhan/typed-sql/blob/main/docs/GRAMMAR_AUTHORING.md)
and [root documentation](https://github.com/Lojhan/typed-sql#readme).

## Diagnostics

Diagnostic meanings become stable at 1.0. Consumers should key automation on `code`, not English
message text. The machine-readable registry is exported as `diagnosticRegistry`.

| Range | Meaning |
| --- | --- |
| `TSQ001` | SQL syntax error |
| `TSQ002` | Parser resource limit exceeded |
| `TSQ003` | Conditional SQL exceeded the configured structural variant bound |
| `TSQ007` | Dialect/snapshot contract mismatch |
| `TSQ100`–`TSQ108` | Catalog lookup, ambiguity, output naming, and cast errors |
| `TSQ202`–`TSQ204` | Unknown/ambiguous functions and unsafe operator inference |
| `TSQ205` | A shared fragment has incompatible parameter expectations across structural branches |
| `TSQ210`–`TSQ217` | CTE, DML arity, join, and subquery safety errors |
| `TSQ301` | Schema or type-policy drift |
| `TSQ401` | Deliberately unsupported dialect surface |

MIT © typed-sql contributors
