# Independent maturity acceptance audit

Audit cutoff: primary repository `/Users/viniciuslojhan/Development/OSS/typed-sql`, commit
`560e3a6`. This is a requirement/evidence review, not a claim that final qualification or merge is
complete. Source observations below were made against that primary checkout, not an older agent
worktree. Native CI run results explicitly marked reported were supplied by the integration owner;
this audit did not rerun Linux SQL Server from macOS.

## Acceptance basis

The controlling requirements are `implementation-plan.md` (especially Product integration and
maturity acceptance), `maturity-audit.md`, the three independent design reviews, and repository
`AGENTS.md`. Historical “pending” paragraphs in those files do not override newer committed tests.
The target is complete product workflows at PostgreSQL/MySQL maturity, with honest dialect scope,
not implementation of every vendor statement. Unsupported MERGE, dynamic PIVOT/external relations,
TVPs/BCP, or VARIANT codecs are not independently missing acceptance deliverables when they fail
closed and are accurately documented. N2 was conditional on concrete parser reuse; both new
grammars own their parsers, so an unused shared parser extension is not a prerequisite.

## Requirement and evidence ledger

| Requirement | Current concrete evidence | Remaining acceptance work |
|---|---|---|
| Neutral ownership and native value plans | Core/compiler native-values tests exercise recursive object/tuple/fixed-array values, typed NULL/empty targets, prototype-like SQL names, hostile descriptors, bounded metadata, 65,535 targets, immutable copies, and repeated physical-type conflicts. Both grammars own syntax/resolution; no vendor branches are needed in neutral AST. | Include existing PG/MySQL/SQLite regression suites in final coherent-head verification. No new neutral API is identified. |
| Native verification, exact physical identity, cached proof safety | Core optional grammar-owned comparator; compiler tests cover native precision drift despite equal JS types, missing evidence, known mismatch precedence, callback errors, spans/fingerprints, and old coarse proof rejection through `nativeTypeComparison`. SQL DMF and normalized SHOWPLAN services are implemented. | PR #267 external CodeQL SARIF-upload permission failure is a reported merge gate; do not mislabel it a source vulnerability. Recheck final CI after resolution. Comparator semantic changes still require adapter-version changes. |
| SQL Server grammar/coercion/soundness | Independent vendor corpus, invalid-context/metamorphic/dependency tests, public V2 ordered parameters/diagnostic UTF-16 fixtures; source owner reports 20-file 95/90 gate green. Engine/settings/collation evidence, aliases, JSON/XML, native parameter lowering and snapshot validation have tests. | Expanded native string-width/MAX/NULL/catalog oracles must agree with inference on every qualified target after the latest fixes. `3cb8470`/`b2f3fab` add parameterized string fixes/probes; a commit alone is not the native receipt. |
| DuckDB grammar/coercion/soundness | Independent native parsers, bounded native-type tree, nested type/runtime tests, real SDK-isolated 1.5.6/2.0.0 suites, full native semantics corpus, public V2 corpus, explicit unsupported/conservative ledger rows. | Final two-version run after integration; no new syntax breadth is required by this audit. |
| Version and setting evidence | Explicit SQL triangular 14/140 through 17/140,150,160,170; pinned native builds in qualification workflow; DuckDB exact engine/SDK pairs, unknown/future evidence fail-closed tests. SQL provider/session settings and Duck semantic settings participate in analysis identity. | Preserve actual build/product/architecture/settings in final artifact receipts. Do not extrapolate tested Linux x64 transport to unqualified hosts or managed SQL products. |
| Runtime values, lifecycle, cancellation and scopes | SQL direct ODBC native baseline reported green in run 42126558434 on all four builds, including packed workers, exact values, prepared fallback, JSON/money/array and cancellation. Earlier run 42125421799 proves cancellation/deadline/pre-abort across ten compatibility rows. Independent deterministic FFI tests cover borrowed handles, epoch changes, query timeouts, memory bounds, failed reset/free and quarantine. `6571011` resolves synchronous second-worker-construction cleanup. Duck native tests prove cache/validator identity, lazy stream indexing, cleanup/quarantine, transaction misuse and exact nested codecs. | New SQL late-error/multiple-rowset probes at `560e3a6` need actual four-build results. Keep raw wire evidence separate from typed policy evidence: neutral numbers still require finite safe-integral values; JSON17 VARCHAR wire metadata does not itself prove native JSON identity. |
| SQL late errors and result draining | `adapter-probe.mjs` now asserts buffered rejection and streamed failure for `SELECT 1; THROW…` and a second rowset, checks no second rowset leaks, then proves reuse or quarantine. | Newly added source resolves the earlier missing witness; native run is pending at this cutoff. Typed multi-statement SQL remains separately unsupported. |
| Duck appender and services | `advanced.mjs` exercises vector appender bounded progress, root/scoped rollback, defaults/generated columns, staging cleanup, verifier precision/parameters and nonexecuting sampled JSON EXPLAIN without value leakage. | Final integrated two-version receipts; no dummy service/API gap found. |
| Duck installed CLI/build first use | `test.mjs` delegates to `offline.mjs` plus a real project. Both SDK pairs execute six CLI/build commands with SDK present and in a second SDK-free packed consumer while an independent child holds a real write lock. After release, online config performs deliberate native schema generation; `execute.mjs` runs bundled SQL-file and inline queries with nested/exact values. Owner reports latest integrated and online flows pass. | This is implemented and qualified; do **not** repeat the obsolete “Duck S3 missing” finding. Retain final two-profile logs. |
| SQL installed CLI/build first use | Native packed adapter/compiler and runtime probes are real. Canonical SQL quickstart includes provider config, generation/check, SQL files, inline esbuild and execution. | **Concrete missing end-to-end gate:** replay the documented flow through installed tarballs and actual CLI generate/check/types/build plus bundled execution on a qualified native server. Existing generic first-use helper selects SQLite; minimal grammar and SQL-file helpers select PostgreSQL. Manual compiler/native packed success does not prove this particular workflow. |
| Browser playground and editor distribution | Five-grammar browser-only public tarball bundles, native schema/settings controls, real native examples, SQL-file/repeated parameter/source-range tests; built browser verification previously exercised nested hovers/errors. Owner reports isolated all-five tarballs and packaged LSP/host flows pass. Public API/forbidden-driver contracts cover new roots/subpaths and worker entrypoints. | Final integrated packed/browser/editor receipts after late exports/worker changes. Do not require every host × every SQL feature combination beyond the reviewed representative packaged flows. |
| Public conformance and feature matrix | Five-grammar canonical ledger, owner-reviewed exact/conservative/unsupported boundaries, 70 SQL and 16 Duck public static probes, ordered parameter public projection, explicit UTF-16 diagnostics; native runner requires qualified SQL environment and isolates Duck SDK processes. | Retain live runner results against qualified targets. Maintainer static corpus reuse is labelled honestly; it is not claimed as independent packed-consumer proof. |
| Performance | Separate SQL/Duck parser p50/p95/p99 budgets and analysis throughput/latency budgets are present and exercised by the shared gate. | A fresh complete-head performance artifact is required. Configuration or historical passes do not prove the final implementation meets budgets. No measured regression is asserted here. |
| Documentation and compatibility | Both quickstarts/dialect pages, type policies, driver/grammar matrices, exact-vs-range distinctions, versionless installs and native boundaries exist. `560e3a6` fixes the bulk-data universal batch atomicity claim and adds Duck vector appender navigation; API/execution docs already distinguish atomic new-engine batches. | Run canonical link/frontmatter/sidebar/documentation checks after final edits. The earlier bulk-guide inconsistency is resolved, not an open gap. |
| Release and package boundaries | Stable manifest entries, changesets, explicit driver entrypoints, browser leaves, no SDK grammar dependencies, private helper exclusions and actual tarball contract tests exist. #266 portable snapshot leaf is reported merged; #264 native structural values is merged. | Product integration draft #265 and dependent PR #267 need final review/checks/merge; retain complete package/release contract results. Package declarations/manifest membership do not authorize a publication claim. |

## Prioritized remaining work

1. Finish the native SQL semantic oracle loop for parameterized string dimensions, MAX/NULL and
   catalog/settings witnesses; retain all four exact-build/ten-compatibility receipts. Correct
   inference or oracle from actual evidence, never weaken a comparison to obtain a pass. Native
   DMF nullable=1 means nullable **or undetermined**, not definite evidence of possible SQL NULL.
2. Add and run the SQL installed first-use CLI → snapshot/generation/check → SQL-file/inline
   esbuild → native execution replay. Include a genuinely offline snapshot path; native provider
   initialization should occur deliberately for online generation, not implicitly during build.
3. Run the committed late-error/multiple-rowset witnesses on the real direct ODBC path. Confirm
   buffered results are withheld on failure and streams report late failure with safe cleanup.
4. Collect the final Q receipts from one coherent integration head: `pnpm verify`, soundness,
   coverage, packed-consumer and forbidden-driver contracts, performance, browser bundles,
   packaged editor/hosts, Duck two-version packed/offline/online flows and pinned SQL matrix.
   Resolve the external PR #267 SARIF permission gate and review the final product MR before
   merge. Report failures and explicit unavailable capabilities rather than treating source
   coverage percentages as native behavioral proof.

No additional generic lexer, codec callback system, driver coupling in grammar roots, or broader
SQL feature promise is proposed. This audit identifies acceptance evidence still needed; it does
not declare the objective complete.

## Source review update at 9262ad0

Primary checkout now includes `81c8c46` (PR #267 on main), so the earlier #267 merge/SARIF
permission item is closed. The earlier SQL first-use **implementation** gap is also closed:
`e2e/sqlserver/first-use.mjs` and `project/` replay installed CLI generation, declarations, check,
manifest, strict tsc, SQL-file/inline esbuild, deliberate bigint interpolation rejection, SDK-free
offline configuration, and actual execution. `c666c4e` adds installed live verification and structured
value-free SHOWPLAN, two cached-verification replays with zero SDK imports, native comparison proof
flag and preserved source entries. These committed assertions still require their native execution
receipt; this update does not claim a CI result it did not inspect.

At this cutoff, scalar-expression `FOR SYSTEM_TIME AS OF` syntax is rejected, and a native bare
100ns precision probe is committed (`bc12b48`). The intended occurrence-specific bare binding and
alias physical-metadata repair have not yet landed in this checkout. Their review remains pending,
not implicitly approved by the presence of that probe. Required review points are: direct parameter
AST sites only; temporal-table/version evidence; ordinal/range association through comments,
normalization, repeated fragments and logical argument reuse; scalar occurrences of the same
argument keep CONVERT; no renderer-global native-cast removal; prepared identity includes the final
physical SQL and targets; unavailable alias identity/facets fail closed rather than guessing.

The existing synchronous generic service factories with the S3 fresh-owned-session pool satisfy
reviewed service/lazy-config requirements. PG/MySQL/Duck driver convenience wrappers are ergonomic
precedent, not an additional mandated `/odbc` export. No convenience API is proposed as a blocking
requirement.

## Minimal coherent product MR split

The already merged neutral structural plans, portable schema leaf and strict verification contract
are prerequisites, not changes to duplicate in a new package MR. Split from current main by final
file content, not by cherry-picking the exploratory aggregate history. A practical minimal stack is:

1. **SQL Server package and qualification.** Own `packages/sqlserver/**`,
   `.changeset/sqlserver-grammar.md`, `examples/sqlserver/**`, `e2e/sqlserver/**`, and
   `.github/workflows/sqlserver-qualification.yml`. Include SQL-only registration hunks in root
   project references, lockfile/package scripts, release manifest, CLI init/tests, package graph,
   public API and packed-consumer inventories, plus SQL parser/analysis performance measurements.
   Include canonical SQL dialect/quickstart/example pages and their required sidebar/docs-contract
   registration so package README links resolve. Retain the independent native corpus, direct FFI
   probes and first-use project with this package; they are its acceptance evidence.
2. **DuckDB package and qualification, stacked on the SQL registration base.** Own
   `packages/duckdb/**`, `.changeset/duckdb-grammar.md`, `e2e/duckdb/**`,
   `e2e/build/test/duckdb.test.mjs`, its native CI shard/artifact upload, and equivalent Duck-only
   project/manifest/CLI/package-contract/performance registration hunks. Include the three canonical
   Duck pages plus their navigation/contracts. Keep pinned SDK aliases in development/test-only
   dependency and lockfile hunks; do not introduce a production SDK dependency.
3. **Shared five-grammar product integration.** Own the playground/components and shared commerce
   schema, editor-hub/packaged host fixtures, browser public-tarball tests and host registry,
   five-grammar feature ledger and generated grammar matrix, conformance scripts/native runner and
   tests, common README/compatibility/type-mapping/execution/bulk docs, and remaining shared docs/
   navigation contracts. Include the conformance public-parameter projection with its own Changeset
   here, or merge it as a separate small neutral prerequisite if independent review is preferable.
   CLI user-visible registration Changeset may be shared here only if its actual CLI changes are
   also here; otherwise split the Changeset alongside package-specific CLI hunks.

Shared files need semantic hunks, not exclusive ownership by one MR: extracting each whole global
file from the aggregate would register an absent second package or leave contracts inconsistent.
Each package MR must build/typecheck/test and satisfy its own honest distribution contracts before
merge. The final integration MR supplies the full collective browser/editor/ledger acceptance; a
package MR merge is not a declaration that the entire user objective is complete. Keep the draft
aggregate as a review aid until the split stack reproduces its final tree, then retarget or close it
explicitly rather than merging the same product changes twice.

The remaining cross-stack gate is final coherent-source qualification: package 95/90 coverage,
neutral regressions, soundness, real tarballs and worker paths, browser/editor hosts, native SQL
four-build/ten-compat matrix including pending AS OF/alias changes, Duck two-version full packed
workflows, canonical docs, performance and release/distribution contracts. Do not accept stale
pre-repair native receipts for altered physical SQL or metadata normalization.

## Integration receipt update: 95478f3

- Full `pnpm verify` attempt on the integrated source passed all package suites, including
  SQL Server strict coverage (96.35% lines, 90.89% branches), and 44/45 repository contract
  files. The sole failure was a broken bulk-data execution link. Commit `95478f3` fixes the
  link and the full documentation contract then passes. This is not recorded as an
  uninterrupted green `pnpm verify` run.
- The subsequent production `pnpm build`, canonical `pnpm docs:build` (27.02 seconds),
  nine-file `pnpm test:soundness`, and `pnpm performance:gate` pass. Performance evidence
  identifies clean head `95478f3`, budget version 17: SQL analysis ~8,997 queries/second,
  parser p95 4.66 ms; Duck analysis ~11,134 queries/second, parser p95 3.53 ms. No budget
  was relaxed. SQL AS OF lowering `465a85e` is included in those build/soundness checks.
- Native run [42136571758](https://github.com/Lojhan/typed-sql/actions/runs/42136571758)
  provides 40 raw temporal parameter probes across four engines and ten compatibility
  combinations. Bare bound parameters agree with literal execution at the exact current
  period boundary and 100 ns before it under both MDY and DMY. The typed AS OF renderer
  still failed in that run; `465a85e` uses only AST-attested datetime2(7) temporal
  occurrences and preserves explicit conversion in other contexts.
- The same run exposes an alias result metadata defect (`catalog_alias` cannot yet be
  normalized) before the rowversion concurrency stage. No rowversion success is inferred
  from absent evidence. The packed first-use failure is setup DDL being discovered as a
  query; `526af59` moves that exact DDL outside query discovery and passes a real SDK-free
  installed replay, while preserving configured native setup.
- Native run [42137635548](https://github.com/Lojhan/typed-sql/actions/runs/42137635548)
  tests the AS OF and first-use repairs at `f1ae218`. It is in progress at this receipt
  update; alias attestation and final coherent-head qualification remain incomplete.
- Public parameter projection is isolated as [PR #268](https://github.com/Lojhan/typed-sql/pull/268),
  with local typecheck and full conformance tests passing. CI remains the merge gate.

### Native rerun result: f1ae218

Run [42137635548](https://github.com/Lojhan/typed-sql/actions/runs/42137635548) is terminal.
All four core adapter stages pass. Compiled AS OF catalog counterexamples clear on all
ten compatibility rows; alias result metadata remains the only catalog case failing before
rowversion. The complete packed first-use stage passes on SQL Server 2017/2019/2022.
SQL Server 2025 completes its online/offline/build/execution and installed live/cached
verification/plan assertions, with explicit `repeated-fragment-cardinality` plan skip, then
fails disposable cleanup on successful informational native 5060/SQLSTATE 01000 records.
The downloaded `first-use-17-native-services-summary.log` records two cached replays with
zero SDK imports; verification skips are empty. This is evidence of those phases, not an
end-to-end green 2025 packed stage. Microsoft lists 5060 as severity 10 rollback progress
in its [5000–5999 error catalog](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/database-engine-events-and-errors-5000-to-5999).
A narrow successful-notice fix and independently asserted completed cleanup remain required.

### Native alias/rowversion and compiled boundary receipts: 8028e92

Run [42138505866](https://github.com/Lojhan/typed-sql/actions/runs/42138505866) has completed.
Every engine passes its adapter and full packed first-use stages, including independently
confirmed database cleanup on SQL Server 2025. Across ten compatibility rows, downloaded
catalog artifacts prove alias decoding and rowversion optimistic concurrency: update changes
the eight-byte token, stale update returns zero rows, and oversized input rejects before SQL.
There are 120 compiled temporal boundary/mixed-context probes: 80 MDY positive executions and
40 expected DMY attestation rejections, with no unexpected probe errors.
The only remaining catalog failures occur later on successful informational unbinding message
15520. `d01acff` explicitly admits only documented successful 15519–15524 notices, retaining
15517/15518 rejection, SQL_ERROR rejection, and truncation/unknown-record checks. Native rerun
is required after that repair and the independent native-family fallback repair.

The next full local `pnpm verify` attempt passed package suites through the new SQL coverage
gate, then timed out at the existing preview compiler watch test (20 seconds, config dependency
refresh). Its unchanged focused SQL-file suite subsequently passes in 3.84 seconds. This is
recorded as a failed full attempt plus a successful focused recheck, not a full green receipt.
Final verification remains open.

Independent cross-review additionally found contradictory built-in-spelled ODBC metadata could
bypass alias-registry checks, and Duck health/prepare work could run before cancellation controls.
Both are required correctness repairs before package approval, even if current PR CI is green.
