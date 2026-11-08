# PostgreSQL native contract checkpoint

This is intermediate implementation evidence for the [final architecture](./spec.md). It does
not qualify all PostgreSQL queries, all engine versions, the other grammars or automatic live
regeneration. The implementation ledger retains the complete remaining scope.

## Real engine evidence

The local isolated container is PostgreSQL 18.3 with the application-owned pg 8.23.1 driver.
`test/helpers/postgres-native-contracts.ts` supplies the proof to the existing PostgreSQL E2E
lifecycle. Its PostgreSQL 18 branch:

1. Creates a dedicated fixture schema and a bigint function absent from the compiler snapshot.
   The function increments a counter when actually executed.
2. Confirms the offline analyzer cannot infer the result precisely.
3. Acquires exact parameter and result metadata through the registered session interface. The
   counter remains zero, nullability remains unknown/nullable, and pg's named cache remains empty.
4. Exports and reloads the native contract, compiles the application query and its runtime plan,
   executes the compiler-transformed query and decodes bigint output. The counter becomes one.
5. Injects DDL between description and context validation; no replacement contract escapes.
6. Closes native clients and recompiles identically from the exported closure.
7. Copies distribution-only package files to an isolated temporary installation outside the
   workspace, removes the analyzer/parser/global catalogs and confirms the driver cannot resolve.
   A fresh Node process recompiles the actual native closure identically with JavaScript network
   traps installed. Missing durable objects fail loading. This is not an OS network sandbox.

The root packed-consumer gate separately uses actual tarballs, validates the exported profile/tag
surface, removes heavy PostgreSQL modules and checks contract compilation and runtime decoding.
Its synthetic evidence fixture is distinct from the real engine proof above.

## Acquisition scope and consistency

The producer currently qualifies PostgreSQL 18 expression-only SELECT queries, known built-in
casts and ordinary calls. Relation/view/FDW binding, subqueries, custom type-input coercions,
extensions other than plpgsql and other majors are rejected. This bounded statement scope is
not a substitute for the final capability matrix.

Parse/Describe sends no candidate Bind/Execute. RowDescription reports type OIDs/modifiers,
not expression nullability. These protocol boundaries are documented in PostgreSQL's
[message formats](https://www.postgresql.org/docs/18/protocol-message-formats.html).

A dedicated read-only session pins relevant settings. Catalog records, role information and
settings are hashed with SHA-256 inside the server; their source text does not enter artifacts.
The producer captures the WAL insertion position and rejects any advance during acquisition.
PostgreSQL defines that position as the logical end of WAL and exposes it without requiring
superuser permissions. See [WAL position functions](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-ADMIN-BACKUP).
This guard is conservative: data writes, unrelated writes or hint-page logging can reject a
capture. Context inspection retries bounded unstable intervals; description never accepts them.
A quiet migrations-derived qualification database is the intended strong environment.

Native arrays/custom representations and unavailable bind evidence remain unknown/unavailable.
This checkpoint establishes neither arbitrary extension safety nor application statement effects,
cardinality, JSON shape, whole-project native-required reconciliation or dependency precision.

## Profile size evidence

Run `node planning/hybrid-analysis/measure-profile-bundles.mjs` from the repository root after
installing workspace dependencies. The tool reads working-tree source, records input/tool digests
and writes its report under `artifacts/grammar-catalog`. The checked-in
[measurement](./postgres-profile-measurements.json) records this checkpoint's input hashes.

The synthetic minified ESM/Node ES2022 samples are:

| Entry | Minified bytes | Gzip bytes | Global catalog inputs |
| --- | ---: | ---: | ---: |
| Lightweight tag and plan helpers | 17,767 | 5,646 | 0 |
| Lightweight PostgreSQL profile | 44,739 | 12,404 | 0 |
| Neutral compiler/contract loader plus PostgreSQL profile | 114,149 | 33,309 | 0 |

Compression uses gzip level 9 and Brotli quality 11 with esbuild 0.28.2. Small generated lexical
vocabulary remains in the profile. These entrypoints differ from the original full analyzer
baseline: do not turn their difference into a claimed application savings percentage. They do
not measure installed package size, a realistic query corpus, all five grammars or final core/packs.
The complete old catalogs are still shipped until their consumers are migrated.

## Independent qualification update

The real-engine helper now runs the pure PostgreSQL reconciliation owner against a separately
produced offline claim. It verifies that an injected wrong successful static type returns conflict
without a qualified contract. Only the successful qualified artifact is exported. Disconnected
and isolated consumers require the hash of the independently configured native-required policy.

Qualification records bind the native evidence and source contract, normalized static claim hash,
owner revision, required native facets and the complete comparison closure. Nullability certainty
is explicit; unknown/upper-bound evidence cannot certify an exact non-null fact. The publisher
currently retains the conservative native plan. Retaining independently qualified static-only
refinements and supporting static/native parameter-authority alternatives remain open.

Acquisition interpreter v2 qualifies built-in base representations using native namespace/kind
metadata. A custom type's mapping in the supplied schema does not establish independent native
representation evidence. Custom/opaque runtime types remain unavailable in this adapter.
The bundle table above records the earlier source checkpoint; it is not a new size measurement
of this additional qualification machinery.
