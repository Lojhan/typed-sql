# Full specification completion audit

The [22-scenario ledger](./acceptance-audit.md) is an evidence index, not the complete requirement
set. This audit checks the [specification](./spec.md), command surface and earlier requirements
as well. A scoped passing fixture does not establish universal SQL coverage or full completion.
The source inspected begins at `fe344898`; subsequent additions below require their own final gates.

## Current specification

| Sections | Required result | Current evidence and remaining work |
| --- | --- | --- |
| 1–2 | Three evidence layers; grammar-owned semantics; fail-closed qualification; no application execution during acquisition | Neutral contracts, project contributions, owner reconcilers and guarded native adapters; acceptance scenarios 2, 9–14, 17 and 20. Declared statement/type limits remain binding. |
| 3 | Complete declared vocabulary accounting; generic calls; bounded cores and explicit optional loading | Five pinned vocabulary projections and parser/native context audits; independent language inventories and signature knowledge markers. Core selection uses the 37 finite maintained commerce candidates, not production popularity. Sampling and unavailable facets stay explicit. |
| 4 | Offline/frozen/live network policies and separate qualification policy | Cold packed consumer, frozen CLI/build/editor and native-required generation tests. Frozen requires every checked variant and ignores disposable cache. |
| 5 | All specified commands, flags, generation and review behavior | Check/watch/generation already integrated. Final audit found missing `cache status`/`cache prune`; these now have focused command tests. Status is read-only and explicitly cannot observe another process's active requests. Local CLI, package, documentation and editor gates pass; fresh hosted qualification remains open. |
| 6 | Contract-first lookup, independent reconciliation and negative evidence | Frozen/offline/live views, deliberate wrong-rule tests and native query qualification. Availability cannot restore retired evidence; cache-generation regressions include actual offline replay. |
| 7 | Selected raw declarations, explicit reuse permissions and contribution ownership | PostgreSQL fixed-scalar project captures, signature metadata and neutral synthetic/inherited contributions. Other reusable rule families remain unavailable rather than inferred from one invocation. |
| 8–9 | Versioned, validated ordered result/parameter facts and decoder agreement | Contract/value-plan/native evidence validation, parameter occurrence mapping, grammar codec tests and independent descriptor-family/facet gates. Unknown and partial evidence remains represented. |
| 10 | Finite variants and qualified unknown syntax; dynamic cases conservative | Candidate extraction, finite branch/slot tests, native static rendering and SQLite authorizer controls. No universal parser bypass is claimed. |
| 11 | Owned disposable cache, durable closure, atomic export and semantic diff | Cache/process/closure tests establish persistence mechanics. Final audit found digest-only generation output; semantic query/declaration diffs now retain before/after fields and current callers, with check-only JSON tests. Removed queries have no current caller; historical source paths are not durable evidence. Local CLI, package, documentation and editor gates pass; fresh hosted qualification remains open. |
| 12–13 | Complete context keys, explicit freshness and conservative invalidation | Per-owner context matrix and native mutations; request-driven context checks and live status timestamp. No idle remote polling is promised. Endpoint/profile changes require new observation or explicit recorded selection. |
| 14 | Bounded scheduler, pending/stale/failure states, cancellation and atomic publication | Scheduler and shared-session tests cover state transitions, concurrency, backoff, cancellation and cache generation fencing. TSQ409 now reports native-pending work at source ranges. Unit tests fence stale timers/document versions/service owners and coalesce subscribers. Controlled stdio tests cover SQL/templates, push/pull, an edit during pending work, ordinary TypeScript errors and slow context observation without a completion-refresh loop. Prepared snapshots retain their async artifact guard. Local public API/packed gates and PostgreSQL 18.6 pass on committed source `c3eeb1cf`; the complete current hosted matrix remains required. |
| 15 | Immutable synchronous compiler views; isolated preview host; evidence explainability | Build/CLI/LSP prepared views and package-boundary gates. Final audit found missing origin/context in hovers; template and SQL-file tests now assert both with unverified freshness. Local CLI, package, documentation and editor gates pass; fresh hosted qualification remains open. |
| 16 | Renderer/value-plan runtime; no analysis/native/cache dependencies | Installed frozen consumers delete semantic/native modules; runtime/profile/frozen bundle graphs retain zero global catalogs. |
| 17 | All owners use registered capabilities with actual version limits | Descriptor, native protocol, class rejection and inherited grammar proofs. Unsupported facets and profiles are explicit; no dummy-value execution fallback. |
| 18 | Private bounded owned storage and namespace isolation | Cache validation, corrupt/linked-object rejection, concurrent writer/prune tests, factory traps and redacted diagnostics. New read-only status validates ownership/index snapshots and reports references, not certified remote validity. |
| 19 | Expected ownership/topology and lightweight API transition | Package graph/public API/packed tests, explicit analyzer/pack/profile exports and migration documentation. Public API and packed gates pass locally; the complete current hosted aggregate remains required. |
| 20 | Explicit old requirement disposition | The table below maps every earlier specification section. Exhaustive offline semantic parity is replaced, not silently claimed complete. |
| 21–22 | Measured costs, workload limits and phased delivery gates | Four cost reports share committed source `c3eeb1cf`; native workload limits are documented separately. The current additions are measured at that pin; future production changes require a fresh measurement pin. Final required CI remains open. |
| 23–24 | All acceptance scenarios and remaining decisions reconciled | Acceptance ledger retains declared boundaries. Full completion also requires closure of the additional host/tooling checks above, current required CI and review state. |

## Disposition of the earlier specification

The [historical specification](https://github.com/Lojhan/typed-sql/blob/e194abb4f55523f435995a74d7d8ab58c2c42977/planning/grammar-completeness/spec.md)
is retained in Git rather than restored with its vendor corpus. These dispositions preserve its
useful requirements while applying the accepted query-contract design.

| Earlier section | Disposition | Current proof or boundary |
| --- | --- | --- |
| 1. Outcome/scope | Replaced | Query contracts are primary correctness inputs; universal offline parity is no longer promised. |
| 2. Decisions | Replaced/retained individually by current section 20 | No runtime native access, neutral ownership, provenance and fail-closed behavior remain invariants. |
| 3. Baseline/constraints | Retained as measured history | Exact base/discarded/current Git revisions in repository and bundle reports. |
| 4. Topology | Replaced | Neutral analysis package, grammar cores/packs/adapters and project-local durable inputs. |
| 5. Acquisition/normalization/reconciliation | Retained within declared scope | Independent inventories, rich signatures, context qualification and facet reconciliation; no global corpus required for normal builds. |
| 6. Engine source contracts | Retained for audit facts | Pinned vocabulary/type witnesses and independent native inventories for all five owners. Unavailable signature fields remain explicit. |
| 7. Intermediate representation | Replaced | Versioned project declarations, native evidence and exact contracts separate reusable permission from invocation evidence. |
| 8. Host/generated projections | Replaced | Contract-first compiler inputs and bounded grammar semantics, not exhaustive generated global function dispatch. |
| 9. Loading/API transition | Retained | Explicit lightweight profiles, analysis imports, compatibility packs and packed-consumer evidence. |
| 10. Independent live auditing | Retained | Automatic language/type/vocabulary audits, reviewed fingerprints and native class controls. |
| 11. Coverage/qualification | Retained with new algebra | Separate inventory recognition, offline workload success, native admission and facet-qualified contracts. No name-count-to-popularity conversion. |
| 12. Commands | Replaced | Current specification section 5; cache maintenance and semantic diff gaps are tracked above. |
| 13. Bundle/runtime acceptance | Retained | Measured graphs and disconnected installed consumers; drivers/tools are separate installation costs. |
| 14. Maintained work | Replaced | Grammar semantics/codecs plus neutral orchestration; no promise to eliminate all maintained rules. |
| 15. LOC/artifact projections | Replaced | Actual exact-revision measurements split maintained/generated/tests/audit data, installation and project artifacts. |
| 16. Migration/exit criteria | Replaced | Current delivery sequence and all acceptance requirements; no exhaustive offline migration gate. |
| 17. Validation/delivery | Retained | Full quality/types/coverage/docs/native/packed/editor/performance and review gates remain required. |
| 18. Results/estimates | Replaced | Actual scoped measurements and declared limitations supersede numerical projections. |
| 19. References | Retained as provenance | Historical source references plus current hash-pinned source manifests and exact producer receipts. |

Local validation of the pending flow passes root types/build, core coverage (98.56% statements,
91.44% branches, 97.85% functions), eighteen language-server files, fifty-four repository contract
files, documentation build, quality and the isolated unchanged performance gate. The CLI/tooling
proofs and analysis coverage remain recorded at their producer in the acceptance ledger.
The required [aggregate at `933dae4a`](https://github.com/Lojhan/typed-sql/actions/runs/42675018288)
passes every required gate, including SQL Server 17's packed editor. The optional MySQL canary
remains unqualified. The new pending flow passes PostgreSQL 18.6
on committed source `c3eeb1cf` in 120.12 seconds, including its standalone typecheck and both E2E
files. All four cost reports are refreshed at that producer. The complete current hosted matrix
remains required.

No completion claim follows from the number of rows here. Those remaining gates must be resolved first.
