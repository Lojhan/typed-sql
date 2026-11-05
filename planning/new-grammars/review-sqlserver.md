# SQL Server independent plan review

Reviewed 2026-11-05 against `implementation-plan.md`, `shared-architecture.md`,
`duckdb-research.md` and `sqlserver-research.md`. This records implementation readiness,
not successful qualification of code that has not been built.

## Verdict

The package boundaries, maturity target and direct ODBC transport design are sound enough to begin
implementation and qualification prototypes. Full package support is **not yet qualified**. The
master plan incorporates the blocking wording dispositions S-R1/S-R2/S-R4 as of this review
revision; the remaining dispositions are explicit implementation acceptance gates. None permits
weakening the requested product maturity or hiding native types behind unknown by default.

## Findings and dispositions

| ID | Finding | Severity | Required disposition and proving evidence |
|---|---|---|---|
| S-R1 | Master DuckDB version section still leaves the support floor to review, while the now-reviewed DuckDB study chooses exact 1.5.6/2.0.0. | Blocking for finalized P0 | Commit initial disjoint engine targets 1.5.6 and 2.0.0 with Neo 1.5.6-r.2 / 2.0.0-r.1. Older 1.4.5 is an unsupported negative; unqualified 1.5.0–1.5.5, hypothetical 1.6–1.9, newer patches/minors/majors and prereleases do not inherit support. Distinguish grammar, native SDK and optional service capabilities. |
| S-R2 | SQL Server lists valid engine majors and compatibility values, but a Cartesian reading would permit impossible combinations such as SQL2017/compat170. | Blocking for support policy implementation | Represent explicit engine/compatibility rows or per-engine maxima: 2017 at140, 2019 at140/150, 2022 at140/150/160, 2025 at140/150/160/170. Additional historical levels are conservative/negative until individually qualified. Every syntax/type feature still has its documented engine/product/settings gates; native JSON's 2025 gate is not a blanket compat170 gate. |
| S-R3 | Direct msnodesqlv8 numeric fidelity is supported by published native source/tests, not yet this repository's own real-engine execution. | Blocking for any exact transport claim | Add an explicit qualification prototype before S1/S2 relies on the policy. Linux x64 CI with pinned official SQL Server image, Microsoft ODBC18/native6.2.2, actual version/settings evidence, query/prepared/OUTPUT numeric and temporal roundtrips. Until it passes, call it a proposed path. Upstream tests are research evidence, not our acceptance result. |
| S-R4 | Master MR table places exact ODBC qualification only under S2; this risks building most of the product on an unverified native transport assumption. | Blocking for MR dependency graph | Split a small R0 transport qualification MR/prototype as an input to final N1/native descriptor shape and S1 policy decisions. It may run in parallel with neutral descriptor implementation, but exact policy cannot be called ready solely because N1 exists. Reuse R0 probes as permanent E2E tests rather than disposable evidence. |
| S-R5 | Opaque native metadata is correctly treated as untrusted, but placeholder lowering's identity must cover more than SQL text. | Required implementation acceptance | Grammar parses and canonicalizes allowed native types and numeric dimensions. Descriptor + policy/version + lowering revision participate in executable/prepared identities where they change native SQL or binding. No cache hit may reuse a different precision/scale/temporal cast merely because logical TS strings and original query text match. Prove compile/build/SQL-file/render/prepared/selector/packed roundtrips. |
| S-R6 | A parameter expression conversion is safer than SELECT wrapping but is not valid in every T-SQL parameter context. | Required implementation acceptance | Use existing per-plan SqlRenderer.placeholder closure on compiled bound-value segments, restricted by grammar analysis to scalar expression sites and typed supported targets. This needs no runtime SQL lexer, AST rewrite or new core callback. Prove TOP expression, OFFSET/FETCH, predicates, VALUES, UPDATE assignments, APPLY/TVF arguments, CAST/CONVERT nesting, OUTPUT expressions and repeated conditional/list fragments. Do not lower identifiers, type names, collation names, hint arguments, variable declarations, OUTPUT INTO target names, procedure output parameters or batch control through a scalar CONVERT helper. Unsupported contexts diagnose before dispatch. |
| S-R7 | Direct native Decimal/Numeric bind helpers still convert to double. | Already addressed in design; retain explicit test gate | Bind exact decimal and temporal inputs as validated Unicode text and convert only their compiled bound-value segments using a plan-owned renderer closure; AST analysis still proves each accepted context. Test driver query and prepared execution; never call native Decimal/Numeric helper with a supposed exact string. Do not use mssql/msnodesqlv8 wrapper, which converts exact numeric output to Number before value handlers. |
| S-R8 | Fixed marker spelling can collide with driver/system/local parameters, and frontend logical argument count is not the server parameter count. | Required implementation acceptance | Use a grammar-reserved generated namespace (not node-mssql-reserved @pN), diagnose collisions and distinguish @name binds from @@system and @locals/DECLARE. SQL-file names map to logical inputs while every emitted native occurrence keeps its own ordered bound slot and native descriptor. Check the SQL Server2100 bound-parameter ceiling after structural/list expansion, not just factory arity. Direct ODBC uses positional ? markers; public render spelling (@generated) and adapter spelling (?) must remain explicit and source identities stable. |
| S-R9 | Temporal nanosecondsDelta is native driver data whose meaning cannot be assumed from a Date-shaped object. | Required implementation acceptance | Checked finite valid Date + own verified delta, integer100ns reconstruction and canonical formatting; missing/malformed/negative/out-of-range deltas reject rather than silently truncate. Prove years0001/0099/0100/9999, pre-epoch timestamps, leap days, scales0–7, time-only/date-only anchoring, UTC mode and non-hour positive/negative input offsets. datetimeoffset output is an explicit normalized UTC instant with full100ns precision, not original-offset preservation. |
| S-R10 | Length and encoding facets are native parameter policy, especially Unicode MAX and decimal38 precision. | Required implementation acceptance | Allowlisted native target AST must distinguish MAX from numeric dimensions; validate dimension integers and legal bounds; nvarchar/nchar lengths count UTF16 code units, varchar lengths depend on byte/collation encoding. Test empty strings, supplementary Unicode, near/MAX sizes, binary empty versus NULL, precision38 scale0/38, negative values and explicit rounding rejection. Never concatenate arbitrary databaseType/UDT/collation text from a plan into SQL. |
| S-R11 | Runtime token/result handling can falsely report OUTPUT success before a subsequent server error. | Required implementation acceptance | Buffer successful query results until the request fully settles; reject multiple result sets and preserve trigger/DONE/info/error semantics. Prove OUTPUT plus trigger/error/rollback cases, XACT_STATE/@@TRANCOUNT cleanup, prepared/stream drain and connection quarantine. Unknown output nullability and unavailable metadata remain uncertainty rather than successful verification. |
| S-R12 | Broad “first-class” wording must not imply native ODBC browser compatibility or DuckDB remote/Wasm qualification. | Already addressed; preserve in docs and manifests | Root/query browser graphs must exclude native SDK and Node imports; explicit /odbc and /node-api subpaths own lazy driver requirements and native host support. Browser playground tests grammar inference only. Engine and driver tested matrices remain separate. |

## Cross-review of the shared architecture

The minimal native values design is appropriate: required own object fields, heterogeneous tuples,
optional fixed array length and existing union/literal nodes can express the requested DuckDB native
types without SQL-specific enums in core. Parent/child nullability, hostile descriptors, bounded
recursion and copying must be tested in all recursive consumers. The physical target metadata change
is justified by both integrations. `ParameterCollector` and logical repeated-input compatibility
must not choose the first same-TS-string target when native targets differ.

Schema v2 already represents composite/collection/opaque types and allowlisted server evidence.
Do not bump the schema format simply for SQL Server catalog names. Qualified identity must remain
lossless through generic projections and hashes; if an extension-only catalog identity is dropped by
current consumers, demonstrate that gap before adding a neutral field. SQL Server collation-sensitive
names and DuckDB ASCII identifier folding need separate grammar logic. The lexical toolkit already
handles bracket quotes, prefix strings and nested comments; extending it for @/$ names is a bounded
primitive improvement, not a reason to share an existing private grammar parser.

One companion wording should be updated: the shared report's example explicit SQL Server driver
entrypoint says `/mssql`; exact runtime qualification is now `/odbc` over direct msnodesqlv8, with
`/mssql` an optional narrower compatibility path. This is a description fix, not a core API change.

## Cross-review of DuckDB design

The updated research avoids the most serious maturity traps: standard Neo JS conversion is lossy;
native wrappers and logical-type metadata drive recursive codecs; named/repeated markers are proven
against the actual engine; outer NULL and active tagged NULL UNION differ; fixed ARRAY length and
MAP key identity are explicit; top-level duplicates reject while derived names follow engine rules;
metadata inspection never executes arbitrary query mutations. Version-sensitive provider columns,
SDK result-close differences, settings and file-lock/lifecycle boundaries are appropriately called out.

Retain exact-version probes as deterministic permanent tests, including composite MAP keys and null
values, ARRAY negative/zero/one-past bounds, 1.5.6 versus2.0 logical metadata, typed empty containers
and native pending-result cleanup. Decimal text formatting and temporal infinity/BC/ns behavior need
own input/output roundtrip tests, not only static wrapper inspection. Failed interrupts must not
return the connection to another operation until native work has settled.

## Readiness and unresolved evidence

P0 is ready for finalization: S-R1/S-R2/S-R4 are now incorporated in the master plan as disjoint
DuckDB version windows, triangular SQL Server compatibility combinations and the explicit R0 native
transport prerequisite. Implementation may start on bounded neutral contracts and R0/DuckDB qualification.
Neither new grammar is ready for a public supported/stable claim. Exact SQL Server transport and typed
input lowering remain an explicit live-proof prerequisite, not a research conclusion disguised as a
test pass. The complete maturity checklist in the master plan remains the final acceptance contract.

## Native macOS application scope

The published msnodesqlv8 6.2.2 tarball contains a darwin-arm64 prebuilt native addon.
`otool -L` on that artifact shows `/opt/homebrew/opt/unixodbc/lib/libodbc.2.dylib`, plus system C++
and system libraries. Native Apple Silicon applications can therefore be an adapter qualification
target when Homebrew unixODBC and the Microsoft ODBC Driver18 are explicitly installed, connecting
to a supported external SQL Server. This does not qualify a SQL Server engine running under local
ARM emulation. The current tarball has no macOS x64, Linux arm64 or Windows arm64 prebuild; upstream
documents a source-build fallback for these hosts. Do not advertise those as tested binary installs.
Node supported lines22/24/26 and Microsoft ODBC18/native library versions remain separate matrix
axes. Driver loading stays restricted to the explicit native adapter entrypoint.

Primary macOS setup reference: [Microsoft ODBC installation on macOS](https://learn.microsoft.com/en-us/sql/connect/odbc/linux-mac/install-microsoft-odbc-driver-sql-server-macos).
