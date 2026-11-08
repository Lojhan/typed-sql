# PostgreSQL native contract checkpoint

This is intermediate implementation evidence for the [final architecture](./spec.md). It does
not qualify all PostgreSQL queries, all engine versions, the other grammars or idle remote-change
detection. The implementation ledger retains the complete remaining scope.

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
7. Packs and installs the production dependency closure into a separate temporary consumer outside
   the workspace. Analyzer/parser/global catalog implementations, declarations and maps are removed;
   database drivers cannot resolve. The full frozen CLI checks the actual acquired native closure,
   preserves `bigint | null` and rejects an incompatible downstream TypeScript assignment. Native
   factories remain guarded and JavaScript network traps are installed. A fresh programmatic consumer
   also recompiles identically; missing durable objects fail loading. The database counter remains one.
   External tool dependencies use the existing packed-consumer overrides. This is not an OS network
   sandbox.

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

## Offline CLI and persistent producer update

The real acquisition also runs through the bounded live scheduler with a persistent producer.
The producer validates independently acquired evidence before fenced publication, and the cache
reopens it using exact recorded query/context identities without recreating an analyzer claim.

The helper hides the durable contract directory and runs the actual compiled CLI with `--offline`.
It obtains the otherwise unknown function's bigint result/parameter types from the cache while
analyzer and schema-provider factories throw if invoked. This proves cache-only compiler input;
it does not assert current remote freshness or that the database is unreachable at that point.
Known context change then retires disposable evidence and rejects the earlier producer token.

After native clients close, the actual `--frozen` CLI checks the separately exported qualified
closure. It also checks the real acquired closure in a fresh packed installation with analyzer,
parser, catalog and driver modules unavailable and JavaScript network traps installed. A downstream
assignment incompatible with the recorded native result fails TypeScript checking. The same isolated
installation exercises the high-level programmatic frozen loader. These remain expression-query
proofs for the declared PostgreSQL transport scope, not all-engine or whole-grammar qualification.

## Explicit live CLI update

The compiled CLI now performs its own explicitly registered live prepass. With durable contracts
hidden, the helper qualifies three candidates: the otherwise unknown user-function invocation,
an already resolved literal query, and an imported SQL-file factory with a named bigint argument.
A fresh offline CLI invocation consumes their persisted contracts while analyzer and adapter
factories throw if called. The function counter stays unchanged during description.

The live factory owns a dedicated pg pool and closes it before TypeScript checking. Native context
inspection brackets the finite batch, and each acquisition retains its own consistency checks.
This host currently requires matching selected recorded context inputs; it does not automatically
adopt a changed database context. This checkpoint covers explicit checking; the durable generation
extension is described below. Watch/editor regeneration remains separate. The earlier bundle table
remains a historical measurement.

## Durable query generation update

The same real-engine helper now invokes actual `generate --queries --live` for all three project
candidates into a separate durable directory. A fresh live `--check` comparison matches the export
without changing its manifest. The helper then deletes that live cache and invokes actual frozen
CLI checking against the newly generated closure; analyzer/adapter construction remains guarded.
The original programmatic one-query export and physically stripped consumer proof remain separate.

Generation TypeScript-checks the exact prospective contract view before a guarded manifest commit.
The selected recorded context must still match native observation. No claim is made here about
automatic context adoption, editor/watch regeneration, additional PostgreSQL statement classes,
other transports or the final all-engine frozen distribution gate.

## Automatic context refresh update

The live CLI configuration now omits its pre-recorded context. Installed identities and the selected
target constrain observed PostgreSQL context selection. After the first three-query export, the
helper replaces the user function's body without changing its declared bigint signature. A live
check-only generation observes the new epoch and reports a durable difference without replacing
the manifest. Explicit regeneration adopts the changed epoch. A fresh frozen process consumes that
target-bound export after the live cache is deleted; its analyzer/adapter factories remain guarded.

The function counter remains unchanged by metadata work. Schema/profile compatibility, query
qualification, context observations and current-remote freshness remain separate claims. This
extends the explicit command proof; it does not establish long-lived watch/editor refresh cadence,
additional PostgreSQL statement classes, other engines or final workload/bundle measurements.

The acquisition outage proof terminates a dedicated leased PostgreSQL backend between context
observation and description. Both description and rollback fail. Adapter-owned classification
returns transport unavailability, and the parsed persistent cache lookup, including its publication token and recorded outcome,
is unchanged before and after the failed acquisition. This proves
record preservation for an actual mid-acquisition disconnect, not successful remote verification.

The built language server also consumes the native cache in offline mode while durable contracts
are hidden. Its configuration guards analyzer/provider construction. A protocol client checks the
actual document diagnostics and bigint SQL hover through the pinned TypeScript proxy. This covers
recorded editor reuse; live editor acquisition and SQL-file content-mapper integration remain open.

The live editor proof starts the built stdio host with an explicit native registration and no
durable inputs. That host stays alive while the CLI generates its closure. After the routine body
changes, a request beyond the five-second observation interval advances the editor project
generation without changing document text/version. Diagnostics remain valid and the function
counter remains one. This proves request-driven refresh through the actual proxy; it does not
prove idle DDL notification, general SQL statement support or qualification of other engines.
