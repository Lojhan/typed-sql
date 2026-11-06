# macOS native preview watch investigation

## Confirmed scope

The missed-edit failure reproduces in the official `typescript@7.1.0-beta` native
Darwin arm64 CLI without typed-sql, a content mapper, or a database driver. The
pinned upstream source is `3e9236361fa97a9e6c685f4833ac457ae2d8c50a`.

The standalone [reproducer](./native-watch-repro.mjs) imports only Node built-ins.
It creates 25 imported TypeScript modules in separate directories, removes their
imports while introducing TS2322, then restores the correct source as soon as
that diagnostic arrives. Each stage has a 20-second limit. Set
`NATIVE_WATCH_REPRO_ROOT` to the checkout directory to reproduce the original
ancestor/package-layout context; a temporary directory also works as a control
but did not reproduce in the initial 30-round run.

```sh
NATIVE_WATCH_REPRO_ROOT="$PWD" node planning/preview-watch/native-watch-repro.mjs /absolute/path/to/native/tsc 30 early
NATIVE_WATCH_REPRO_ROOT="$PWD" node planning/preview-watch/native-watch-repro.mjs /absolute/path/to/native/tsc 30 complete
```

The `early` run reproduced on round 2: the edit occurred while stale directory
watches were being closed. The previous compilation reported one error, then no
incremental cycle started for the restored file during the next 20 seconds.
An independent one-shot compilation of the same file reported zero errors.
The corresponding `complete` run passed all 30 rounds (360 edits).

Earlier controls also passed 100 rounds/1,200 early ordinary edits without import
graph changes. A minimal third-party mapper using only JSON-RPC and a text file,
without typed-sql grammar/compiler/config code, reproduced with a changing import
graph. A second version reporting its own mapper diagnostic reproduced too.
The relevant condition is directory subscription churn, not SQL semantics.

The source-level explanation is that the
[watch compiler](https://github.com/microsoft/TypeScript/blob/3e9236361fa97a9e6c685f4833ac457ae2d8c50a/tsc/internal/execute/watcher.go)
prints diagnostics before completing watch reconciliation. Its
[FSEvents backend](https://github.com/microsoft/TypeScript/blob/3e9236361fa97a9e6c685f4833ac457ae2d8c50a/tsc/internal/fswatch/fsevents_darwin.go)
starts replacement streams at `SinceNow` and stops old streams without first
flushing pending kernel events. The trace is consistent with pending events
being lost during that replacement; a native source fix requires its own
before/after qualification.

## Repository changes and limits

- Generated invalid SQL declarations retain a type-only dependency on the same
  grammar module as valid declarations, avoiding unnecessary import-graph and watch churn.
  An empty type import avoids unused-binding diagnostics under `noUnusedLocals`.
  They still expose `never` and SQL diagnostics, and execution still throws.
  Missing runtime entrypoints and bounded-output rejection remain fail-closed.
- Watch tests require the expected diagnostic and completed summary from the
  same compilation cycle. Previous trailing summaries cannot acknowledge the
  next edit. Failures include bounded timestamped output and process status.
- A permanent ordinary TypeScript control covers repeated edits, atomic saves,
  and import-graph additions/removals without loading a mapper or driver.
- SQL integration repeatedly removes/restores columns and changes/restores
  imported bigint policies in the actual pinned native compiler.

These changes do not fix arbitrary rapid source edits in the upstream binary.
Thirty repeated runs of the synchronized tests passed, but an unsynchronized
SQL stress run still stalled after eight successful 60-edit rounds and ten more
edits at that harness's three-second deadline. The standalone upstream failure
uses the full 20-second deadline. Do not describe the import mitigation as a complete native watcher fix.
One earlier stress run overlapped a clean repository rebuild and failed because
the rebuild temporarily removed package artifacts; that run is not evidence
about watcher correctness.

Raw local investigation logs are under `/tmp/typed-sql-watch-*.log`. They are
ephemeral; the standalone reproducer and this record preserve the procedure and
the distinction between reproduced upstream failure and repository mitigation.

## Rejected upstream candidate

An isolated checkout of the pinned upstream source was compiled with Go 1.27.0
and `-tags noembed`; the source tree and application SDK were not replaced.
The unmodified source build reproduced the standalone failure on round 33.
A candidate adding `FSEventStreamFlushSync` before stopping an old stream still
reproduced on round 28. Both failing runs again passed independent one-shot
compilation of the restored source. That candidate is rejected, not shipped.
Its existing shared-stream tests passed three repetitions, demonstrating why
those tests alone are insufficient. Ten 60-edit SQL runs also passed against
the candidate, which likewise does not override the failing standalone control.

The confirmed defect is upstream; the exact safe native correction remains
unresolved. No preview SDK version change, native binary patch, timeout increase,
or sleep-based workaround is included in the repository changes.

## Repository validation

Package compiler tests pass with their existing coverage thresholds. The bridge
suite, ordinary native watcher and SQL-file integration tests pass. Repository
typecheck, quality, documentation checks, production build, and both packed
consumer/editor contract files pass. The final watch tests pass ten consecutive
runs, including `noUnusedLocals` and import-graph controls. The existing local
performance budget gate also passes without overrides. Warnings from existing SVG assets remain
unchanged. Temporary fixture files caused one quality failure during concurrent
research; a clean run passes. These receipts qualify the repository changes,
not an upstream watcher fix.
