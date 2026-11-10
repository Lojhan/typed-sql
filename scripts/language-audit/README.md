# Independent language auditing

This maintainer tool discovers upstream language inventories independently of typed-sql's
catalogs. It does not generate the expected function names from our implementation.
The public grammar contracts and database adapters remain unchanged.

## Offline checks and review

```sh
pnpm audit:language:check
pnpm exec poku test/contracts/language-audit.test.ts --reporter=compact --enforce
```

The check compares current grammar observations with the reviewed baseline. A changed status,
name, overload signature, or captured inventory fingerprint requires review. It detects removals
as well as additions. The contract test also requires an adapter and evidence for every dialect
in the grammar feature ledger, so adding a grammar cannot silently omit it from this audit.

CI and publication run the offline check against committed, reviewed reference fixtures through
`pnpm quality`. The independent **Upstream language references** workflow refreshes vendor
manuals weekly or on manual dispatch, checks the refreshed observations, and uploads the
reference fixtures for review. It is not called by CI or the release workflow: unavailable vendor
websites fail that refresh run without blocking publication. Native engine qualification remains
part of CI and release evidence.

Refresh from the network and review the differences before accepting a baseline:

```sh
pnpm audit:language:refresh
pnpm audit:language:capture-embedded
pnpm audit:language:baseline
pnpm audit:language:report
git diff -- test/fixtures/language-audit planning/language-audit
```

Reference fixtures record source URLs, source hashes, extracted names, version labels and scope.
PostgreSQL and MySQL use their versioned manuals; SQL Server uses Microsoft Learn's versioned
TOC with inherited moniker constraints. SQLite's manual is unversioned, so it is explicitly a
reference inventory rather than an assertion that every name exists in every supported build.
DuckDB snapshots come from each exact engine in a separate process to avoid native symbol sharing.
The SQLite live fixture records its exact source ID; refresh it with the live command below.

## Inputs for generated mappings

Each function row carries a versioned `signature` object for future catalog generation, alongside
the original engine fields. It preserves overload identity, parameter order/names/native types,
input/output modes, named options, variadic element types, default-expression evidence, return
types/columns, aliases, macro definitions, strictness and volatility where the upstream source
exposes them. The capture envelope supplies the exact version and provenance. `null` and knowledge
markers represent unavailable facts; a name-only reference entry never fabricates a signature.

PostgreSQL retains its complete argument/type/mode arrays and native default SQL list. SQL Server
retains parameter and return-column metadata; TSQL default metadata is incomplete, and CLR default
values retain their base type and converted binary representation. DuckDB retains positional and
named parameters plus macro definitions. SQLite exposes arity/encoding/flags, with dynamic argument
and result types. MySQL's public built-in reference does not expose complete formal signatures.
Preparation evidence also retains native result descriptors where available: MySQL wire fields,
SQL Server result-set descriptions, DuckDB logical types, and SQLite column metadata. These
describe the generated invocation, not a universal signature for every possible argument value.

MySQL parameterized probes also retain the independent input definition block: ordered slot,
native type code, flags, character set, length and decimal digits. The result of an explicit cast
does not stand in for its input descriptor. An absent parameter block stays unavailable rather
than becoming zero parameters. The MySQL engine matrix checks this protocol boundary without
executing the candidate statements.

The intended generation flow is captured facts → grammar-owned policy → generated catalogs.
Coercions, polymorphism, nullability, special syntax, decoding and availability between observed
versions remain explicit policy. In particular, PostgreSQL strictness does not establish that a
function always returns non-NULL for non-NULL arguments. A generator must retain `unknown` or a
diagnostic when facts/policy are insufficient. Fresh native discovery continues to audit generated
catalogs; it must not derive expected coverage from the generated mappings themselves.

## Live discovery

```sh
TYPED_SQL_AUDIT_URL='postgres://...' pnpm audit:language live --dialect postgres --output artifacts/language-audit/postgres.json
TYPED_SQL_AUDIT_URL='mysql://...' pnpm audit:language live --dialect mysql --output artifacts/language-audit/mysql.json
TYPED_SQL_AUDIT_ODBC='Driver={ODBC Driver 18 for SQL Server};...' pnpm audit:language live --dialect sqlserver --output artifacts/language-audit/sqlserver.json
pnpm audit:language live --dialect sqlite --output artifacts/language-audit/sqlite.json
pnpm audit:language live --dialect duckdb --version 2.0.0 --output artifacts/language-audit/duckdb.json
```

Node 24.22.2 is the pinned embedded capture environment. PostgreSQL/MySQL/SQL Server credentials
come from the environment; neither connection strings nor arbitrary setting values are written
to artifacts. Discovery queries are read-only. The live CLI generates invocations from discovered
argument types, arities and function kinds, prepares/describes them in the engine, and compares
accepted calls with the grammar. It does not execute those calls. Native rejections stay
unverified; connection failures and unexpected engine errors fail the audit. Native observations
are written to `.recognition.json`; their fingerprint and status counts are part of the reviewed
live baseline. PostgreSQL, MySQL, SQLite and SQL Server matrix probes run the same generator;
SQL Server records each qualified compatibility level. Captures without preparation evidence
explicitly record that limitation.

The collector accounts for functions, keywords, types, operators, casts, collations, settings,
extensions and syntax. Every category has observed facts or an explicit limitation. PostgreSQL
catalogs include internal routines; SQL Server system objects omit parser built-ins, which is why
the independent public function references are also necessary. MySQL help topics are vendor
documentation, not proof of complete type or syntax enumeration. SQLite uses arbitrary declared
types and affinities rather than a finite type catalog. DuckDB's generated cast matrix covers
implicit casts between NULL-castable types; rejected/parametric types are recorded separately.

To enforce exact live inventory drift against a reviewed capture:

```sh
pnpm audit:language live --dialect duckdb --version 2.0.0 --baseline test/fixtures/language-audit/duckdb-2.0.0.json --output artifacts/language-audit/duckdb.json
pnpm audit:language diff --before old.json --after new.json
```

Live baseline comparison requires the same exact engine version. Changes in target context,
coverage, signatures, names or metadata produce a nonzero exit and a full diff artifact. Capture
mode without `--baseline` produces evidence; it does **not** claim that inventory drift passed.
New CI/OS/version captures need review before becoming baselines; collation inventories can
legitimately differ across operating systems.

DuckDB table/pragma positional `colN` parameters retain their positions; named options are
paired with their types and sorted by name. Their upstream map iteration order is not part of
the SQL signature (see the [upstream metadata implementation](https://github.com/duckdb/duckdb/blob/v1.5.6/src/function/table/system/duckdb_functions.cpp)).
MySQL uses its public [HELP interface](https://dev.mysql.com/doc/refman/8.4/en/help.html) and
`SHOW GLOBAL VARIABLES`; it does not require direct reads of privileged help tables or save
arbitrary variable values. Disposable SQL Server database names are excluded from review keys;
compatibility levels, collations and other semantic settings remain part of the context.

The database matrix probes enforce the compact reviewed live index in
`test/fixtures/language-audit/live-baselines.json`. An unknown engine/context or any changed
category fails the matrix while preserving the complete capture in its artifact. Embedded
CI uses the same gate with `--require-reviewed`. To record an inspected capture (standalone,
PostgreSQL/MySQL/SQLite matrix, or SQL Server catalog artifact):

```sh
pnpm audit:language accept-live --input artifacts/language-audit/capture.json
```

This command is an explicit baseline update; CI never accepts its own discoveries. Review the
resulting source diff. The scheduled reference refresh similarly fails on changes and uploads
the new evidence without rewriting the reviewed baseline.

## Evidence limits

Inventory membership is not proof of SQL support. A catalog declaration is classified as
`declared-semantics-unverified`; a successful generated recognition probe still has unverified
semantics. An unknown-function observation is a mapping-gap candidate. Incorrect argument types,
special syntax, table/window contexts, extensions and version restrictions need review before
turning a candidate into a supported mapping. Contextual keyword tokenization is recorded without
mistaking the absence of a dedicated keyword token for a SQL parser bug.

No catalog enumerates every SQL production or proves every semantic rule. The feature ledger,
grammar conformance suites and runtime decoder tests remain necessary. In particular, this tool
does not yet synthesize valid domain-specific arguments for every overload or establish result
nullability, source spans, parameter inference and decoder behavior for every discovered item.
The generated report exposes those verification gaps instead of treating them as successes.

The complete initial function findings are generated in
[the audit report](../../planning/language-audit/missing-functions.md).
