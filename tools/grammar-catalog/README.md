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
PostgreSQL routine/type/cast generation and DuckDB cast generation consume these validated facts
directly. Other projections still consume native payloads during migration; typed facets alone
do not establish complete semantic generation or qualification. Required projection facts reject
unknown values and unsupported type expressions instead of falling back to an opaque native row.

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
