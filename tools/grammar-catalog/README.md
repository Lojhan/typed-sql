# Grammar catalog tools

This private tool workspace owns grammar-neutral acquisition and generation mechanics. Engine
facts and interpretation belong to registered mappers under `src/mappers/`; shared model and
registry modules do not select behavior by engine name.

`createMapperRegistry` accepts arbitrary grammar IDs. Contributions use a distinct ID and
`extends` to inherit a mapper's mechanics while supplying their own fact extraction. Registration
rejects duplicate IDs, missing methods, unknown parents and cycles. It does not mutate the base
registry. The built-in composition root is a list of registrations, not a closed engine dispatch.

Legacy audit/generation commands currently delegate signature extraction, version bands and
context normalization to these mappers. Original capture hashes remain unchanged; normalized
views can reconcile wire encodings without erasing archived profile differences. The full source
pipeline, qualified projections and loading transition are specified in the
[implementation specification](../../planning/grammar-completeness/spec.md).

Contract tests run through `pnpm test:contracts` and include a synthetic external grammar and an
inherited graph contribution. Runtime packages must not import this workspace.

## Validated model

`src/model/schema.mjs` defines the executable model schema. Runtime checks and TypeScript types
come from that definition. `grammar/catalog/format.schema.json` is its generated standalone
draft-07 JSON Schema. Generated schema formatting belongs to the generator, like the captured
corpus; semantic validation and regeneration checks remain required.

The model separates content-addressed entities, exact profiles and source evidence. Routine
facts retain parameter names/modes/default knowledge, generic/native type expressions, fixed
output columns, result/set/nullability knowledge and required semantic policies. Every native
field remains in the normalized payload. Missing original extractor revisions, license data or
semantic evidence are explicit unknowns; a migration cannot invent those facts.

`createCatalog` consumes registered native captures. `import/legacy.mjs` is the migration adapter
for the old corpus. Existing emitters consume its validated compatibility projection. The model
and registry do not import grammar runtime implementations or database drivers.

`groupCatalog` records shared facts, profile-specific variants and unavailable profiles with
membership evidence. A variant is preserved even when an older emitter only accepts shared
facts. `normalizerRevision` hashes the complete tool source tree and pinned direct dependency
declaration. Generation records that digest alongside schema and input digests.

Parsing rejects invalid JSON carriers, malformed shapes, hash/reference disagreement, duplicate
native row accounting, incomplete categories and orphaned data. These checks establish model
integrity; they do not establish SQL behavior or support parity.

Non-routine entities also carry a discriminated semantic facet. Owners populate captured keyword
roles, native type categories/dimensions, operator operands/results/fixity, cast endpoints/contexts,
collation properties, settings and extension versions. Missing properties stay explicit unknowns.
Keyword case folding belongs to each owner. MySQL HELP topics do not establish canonical native
type identities, and a negative DuckDB implicit-cast observation does not establish an explicit
cast. Syntax topic names do not establish productions. The native payload remains loss-preserving.
PostgreSQL routine/type/cast generation, DuckDB routine/cast generation and SQL Server type
generation consume these validated facts directly. Other projections still consume native payloads
during migration; typed facets alone
do not establish complete semantic generation or qualification. Required projection facts reject
unknown values and unsupported type expressions instead of falling back to an opaque native row.

DuckDB routine emission requires typed parameter ordinals/modes, native kind, variadic evidence
and validated property values. Missing required facts, incompatible macro overlays and type
expressions that the runtime cannot express fail generation. Explicit unknown native types stay
unknown. The legacy tuple projection remains a compatibility format; it cannot express
named-only arguments, defaults, output columns or evidence conditions. A generated parallel index
supplies formal positional names to the resolver, preserving the public seven-field tuple. The
generated
`planning/grammar-completeness/duckdb-routine-projection.json` accounts for these facts for every
emitted routine. This report records the remaining host-format migration; it does not qualify
the remaining fields or make them available to the resolver. Legacy helper exports delegate to the
same projector. Named binding uses grammar-owned per-version policy, including 1.5.6 scalar labels
and macro slots, its conditional-expression exception, and 2.0.0 formal slots. Ambiguous slot
assignments fail closed. Quoted function names retain invocation-form evidence; keyword forms
without qualified named syntax require diagnostics.

## Vendor source locks

SQLite's retained source versions have exact Git mirror and Fossil revisions, byte digests and
license-notice references in `grammar/sqlite/sources.lock.json`. Committed keyword facts are
generated by compiling the vendor's own preprocessor-controlled table. The adapter records every
entry, token, mask and enabled state; it rejects unfamiliar output instead of skipping records.
Generation validates the lock, extractor revision and fact digests and regenerates the parser-word
comparison under `planning/grammar-completeness/`. That comparison measures lexical vocabulary,
not SQL semantic support. Parser-only words can include function names and diagnostic sentinels.

`pnpm catalog:source sqlite` refreshes from retained acquisitions or immutable revision URLs and
requires a C11 compiler. Existing version pins are reused; changed acquired bytes fail verification.
New retained/declared versions are discovered from the corpus and feature ledger. Normal build and
check commands consume committed facts without network access or a compiler. Raw acquisitions
remain under ignored artifacts; durable retention and full native compile-profile reconciliation
are still required. Compiled registration facts carry arity and category evidence, with return
semantics still unknown. Additional vendor sources and profile qualification remain open.

`pnpm catalog:source duckdb` discovers exact retained versions and runs the registered source-API
adapter for each supported major. It pins official source/library archives, source revisions,
license notices and extractor bytes. Explicit refresh needs Python and a C++17 compiler; normal
generation consumes committed facts offline. Version 2 retains native parameter names, passing
modes, defaults and typed options. Version 1 retains positional types, varargs, named-option maps
and macro declarations; missing formal names/passing descriptors remain unknown. Its separate
vendor window-name registry is included in the complete count with unavailable signatures explicit.
Legacy facts do not replace the version's binding policy until independently qualified. This is
registration evidence for the recorded platform/profile, not full SQL semantic qualification.

`pnpm catalog:source postgres` acquires the exact PostgreSQL versions present in retained native
captures. It locks the full immutable source archive, selected catalog/parser/SQL inputs and the
PostgreSQL license. Explicit refresh requires Python 3.12 or newer and Perl with its standard
`JSON::PP` module. Catalog data files are discovered from the archive and expanded by the pinned
vendor `Catalog.pm`, including header defaults and generated array types. Content-addressed rows
and schemas share unchanged data between versions; source line locations remain attached to each
catalog entry. Generation validates the fact closure and lock without Python, Perl or network access.

The PostgreSQL emitter compares source keyword names/categories with retained native inventories
and rejects disagreement. Routine descriptors incorporate installation-SQL parameter headers,
unconditional type aliases extracted from grammar actions, and bootstrap default-constant counts.
Source descriptors must match native parameter/result/property metadata before their validated
routine models drive emission. Canonical type spellings come from independent native type metadata;
canonical default-expression rendering, execution, nullability and decoding remain unqualified.
Snowball and PL/pgSQL installation declarations also supply validated routine models; their schemas
come from explicit SQL search paths or extension control files. An unmatched source/native routine
or unsupported installation declaration blocks generation. This covers the retained native routine
inventories, while full grammar productions, SQL bodies, configuration and additional extension
profiles still need separate interpretation and qualification. Committed source text includes the
upstream license notice.

`pnpm catalog:source mysql` locks the full archives and selected registration/lexer/YACC inputs
for every exact retained MySQL version. Explicit refresh requires Python 3.12 or newer; ordinary
generation consumes committed facts with Node only. Keyword reservation follows the pinned vendor
keyword-list generator and must match every retained native keyword inventory. Factory registrations
and lexer-classified function names remain separate. Recognized factory macros supply partial
argument-count ranges, parity and internal-call restrictions. Specialized factories with unconditional
literal class bounds can supply ranges through alias chains, retaining declaration locations.
Dependent bounds, class specializations and guarded declarations retain unknown arity;
preprocessor conditions are preserved without claiming build availability. Formal types,
defaults, result types, nullability, special syntax and decoding require further qualification.
Vendor license notices and immutable source/member digests are retained with these facts.

The SQLite catalog refresh also locks the full vendor archive and builds its amalgamation in a
fresh temporary directory. Archive members must agree with the separately pinned files before
any vendor build step runs. The archive extractor rejects links, special files, duplicate paths
and paths outside the expected revision root. Explicit refresh requires Python 3.12 or newer,
a C compiler, make and the vendor's configure/Tcl requirements; ordinary generation remains
Node-only and offline.

Two explicit source profiles retain the default registry and a build requesting math, FTS5,
RTREE, SOUNDEX, percentile and offset functions. Actual compile options, source identity, global
registrations (including internal entries) and connection-visible functions are retained separately. A wrapper reads
SQLite's own binder for minimum registration arity, including newer negative arity encodings;
these minima do not prove argument-handler constraints. Neither profile represents every
possible SQLite build or the settings of an application-installed wrapper. Return types,
nullability and formal SQL parameter names remain unknown unless separate evidence supplies them.
The generated function comparison accounts for every registration, name absent from policy,
policy name absent from that source profile and connection-only registration. A name present
in policy is a declaration, not semantic qualification.

## Native capture provenance

Fresh audit captures include a schema-validated provenance record binding the normalized target
and complete inventories to an extractor manifest. The manifest records byte digests for the
inventory/normalizer tools and producer entrypoint, the dependency-lock digest and exact Node
runtime. Import preserves this record; normalized sources expose it as typed provenance and
identify the supplied extractor revision. Historical captures keep unknown extractor evidence.

Recorded pins are enforced by input verification: a missing or different pin requires review.
Capture/query/target changes invalidate the capture binding, and manifest changes invalidate its
revision. The model rejects an identified native extractor without its supporting manifest.
These records identify the declared acquisition tooling; they do not establish vendor licensing,
pin every upstream source or retain source bytes. Immutable vendor source locks, complete producer
dependency closure, durable acquisition archives and semantic qualification remain separate work.

## Offline generation

`pnpm catalog:generate` uses the pure Node entrypoint in `scripts/catalog-generation/run.mjs`.
Build and typecheck run it before compiling. Registered owners under `src/generate/` emit their
grammar's catalogs; the shared runner owns input tracking, output ownership and deterministic I/O.
The legacy PostgreSQL/MySQL commands delegate to this same pipeline. Required version endpoints
come from the feature ledger rather than a second version list.

Every emitter finishes planning before output files are staged. Duplicate or conflicting output
paths fail before writes; check mode never writes. Output hashes and the artifact fingerprint join
the model/input digests in the generation manifest. Each replacement is atomic and reports are
written last; a filesystem failure during replacement can still require rerunning generation.

DuckDB alias generation reads captured aliases directly, without importing the generated runtime
parser. PostgreSQL/MySQL core outputs use statically checked object literals. A clean-room contract
copies only generation sources and captured/policy inputs, generates without grammar implementation
sources or existing outputs, then checks the result. Executed PostgreSQL/MySQL catalog values are
also hashed against their declared content revisions. Executable outputs remain tracked during
the migration; removing them requires the remaining distribution and clean-build checks.
