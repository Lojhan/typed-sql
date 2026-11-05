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
