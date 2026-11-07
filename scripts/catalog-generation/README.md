# Grammar catalog generation

The inputs are reviewed upstream facts and grammar-owned semantic policy. Generators replace
runtime catalog declarations; they do not learn SQL semantics from successful example queries.

```sh
pnpm catalog:import artifacts/language-audit/capture.json
pnpm catalog:generate
pnpm catalog:check
```

Generation and check run offline through a pure Node entrypoint. Build and typecheck generate
before compilation, so prior executable catalogs are not bootstrap inputs. Registered grammar
emitters own SQL interpretation and output shapes. The runner validates output ownership before
writing and records each artifact's hash; `check` is read-only. The PostgreSQL/MySQL legacy
generation commands delegate to the same pipeline. Required version endpoints come from the
feature ledger. A clean-room contract verifies regeneration without grammar runtime source files
or prior generated artifacts.

DuckDB common-type derivations have their own reproducible capture because combination typing is
not exposed as a catalog table. Run each SDK in a separate process:

```sh
node scripts/catalog-generation/duckdb-native.mjs capture 1.5.6 grammar/duckdb/catalog/combinations-1.5.6.json
node scripts/catalog-generation/duckdb-native.mjs capture 2.0.0 grammar/duckdb/catalog/combinations-2.0.0.json
pnpm catalog:generate
```

The capture enumerates native types, describes every concrete scalar pair in UNION ALL and
COALESCE contexts without executing expressions, and retains rejected/parametric types explicitly.
CI repeats the derivation and compares the complete result. The same native descriptions generate
scalar type aliases; SQL spelling conventions remain grammar policy.

Import accepts standalone live captures, database matrix artifacts, and SQL Server compatibility
profiles. Import validates the native inventory and normalized signatures; it does not accept an
inference baseline or require broken inference to be approved before new facts can fix it. Its complete
rows, signatures, source queries, exact engine/build/context and unavailable-category reasons are
retained in `grammar/catalog/upstream.json`. Rows and inventories shared by versions are stored
once. Hashes and normalized signature facts are validated before generation. A new capture never
becomes verified merely because it produces compilable generated code. Every native CI profile
also checks that its fresh capture is present unchanged in the generation inputs.

`grammar/*/catalog/policy.json` owns representation, nullability, special syntax, parser vocabulary
and exceptions requiring semantic knowledge. PostgreSQL/MySQL's existing `core.json` files own
type decoding and routine-family policies. The generated registries follow the supported version
bands instead of requiring handwritten imports whenever a version is added.

Generation currently emits:

- PostgreSQL native overloads, input/output modes, defaults, variadics and version membership;
  type categories, preferred-type flags and native spellings also come from native catalogs;
  cast contexts/methods come directly from each engine catalog for policy-supported types.
- DuckDB native signatures, implicit casts, scalar aliases and contextual common-type matrices. Missing macro types stay unknown; specialized
  macro patterns require explicit policy and preserve the original native facts.
- PostgreSQL, MySQL and SQLite parser vocabulary from grammar policy.
- SQLite core/extension function tables, operators, STRICT type mappings and affinity rules.
  The STRICT name inventory is extracted independently from SQLite's official documentation.
- SQL Server built-in declarations, date parts and type rules. Physical widths, precision/scale
  limits, integer bounds and compatible system aliases come from `sys.types`; decoding and
  allowed syntax remain policy.

The PostgreSQL resolver uses generated native candidates for scalar calls and policy-selected
aggregate families. It keeps unsupported overloads visible, applies the grammar's coercion and
decoding rules, and rejects ambiguous or opaque inputs/results. Result nullability is conservative
unless a dedicated semantic rule establishes more. Strict native functions can still return NULL
for non-NULL input.

Live auditing discovers the engine inventory again, generates invocations from that fresh
inventory, prepares/describes them without executing discovered function calls, and compares
claimed native type identities. PostgreSQL uses Parse/Describe/Sync without Bind/Execute and
also generates parameterized probes. Actual type disagreements fail review and cannot be accepted
as a baseline. Unsupported calls and unavailable descriptions remain explicit verification gaps.
DuckDB scalar arguments use typed parameters to avoid constant-NULL folding. SQL Server native
result descriptions are also compared where the grammar supplies a concrete native type.

The current native comparison still shares some type normalization with grammar implementations.
Those lanes detect regressions but do not provide independent semantic qualification. Replacing
that expected-side normalization and qualifying every category remain migration requirements.

`grammar/catalog/generation.json` and `planning/language-audit/generation.md` record every version
band/category, shared versus context-specific facts, unavailable evidence, generated outputs and
the complete input revision. Even audit-only categories invalidate that revision when changed.
The protected CI quality summary requires all native PostgreSQL, MySQL, SQL Server, SQLite and
DuckDB audit lanes; a skipped, missing, cancelled or failed lane cannot pass the summary.

MSSQL/MySQL built-in metadata and SQLite's dynamic typing do not provide universal formal return
signatures. Moving their policies into generated tables does not remove the need to maintain
those policies. Syntax productions, value-dependent behavior, nullability, compile options and
runtime decoding still need their owning grammar's conformance tests.
