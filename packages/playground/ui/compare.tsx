import { useMemo, useState } from "react";
import { compareGrids, milliseconds, resultGrid, totalTime } from "./result-model";
import { ResultGrid, useResultPage } from "./results";
import type { Run } from "./types";
export function ComparePanel({ runs, initialA }: { runs: Run[]; initialA?: string }) {
  const [leftId, setLeftId] = useState(initialA ?? runs[1]?.id ?? runs[0]?.id ?? ""),
    [rightId, setRightId] = useState(runs[0]?.id ?? "");
  const [leftResult, setLeftResult] = useState(0),
    [rightResult, setRightResult] = useState(0),
    [page, setPage] = useState(0),
    [mode, setMode] = useState<"ordered" | "multiset">("ordered");
  const left = runs.find((run) => run.id === leftId),
    right = runs.find((run) => run.id === rightId);
  const a = useResultPage(left, leftResult, page),
    b = useResultPage(right, rightResult, page);
  const leftGrid = useMemo(
      () =>
        a.data
          ? a.data.hasPage === false
            ? {
                ...(resultGrid(left?.results[leftResult]?.value ?? { kind: "array", items: [] }) ?? {
                  columns: [],
                  rows: [],
                  truncated: false,
                }),
                rows: [],
              }
            : resultGrid(a.data.value)
          : null,
      [a.data, left?.results, leftResult],
    ),
    rightGrid = useMemo(
      () =>
        b.data
          ? b.data.hasPage === false
            ? {
                ...(resultGrid(right?.results[rightResult]?.value ?? { kind: "array", items: [] }) ?? {
                  columns: [],
                  rows: [],
                  truncated: false,
                }),
                rows: [],
              }
            : resultGrid(b.data.value)
          : null,
      [b.data, rightResult, right?.results],
    );
  const difference = useMemo(
    () => (leftGrid && rightGrid ? compareGrids(leftGrid, rightGrid, mode) : null),
    [leftGrid, rightGrid, mode],
  );
  const full =
    !!a.data?.complete &&
    !!b.data?.complete &&
    (left?.results[leftResult]?.paging?.pageCount ?? 1) === 1 &&
    (right?.results[rightResult]?.paging?.pageCount ?? 1) === 1;
  const selector = (
    side: "A" | "B",
    selected: string,
    set: (id: string) => void,
    result: number,
    setResult: (index: number) => void,
    run: Run | undefined,
  ) => (
    <div className="comparison-selector">
      <span className="side-badge">{side}</span>
      <select
        aria-label={`Run ${side}`}
        value={selected}
        onChange={(event) => {
          set(event.target.value);
          setPage(0);
          setResult(0);
        }}
      >
        <option value="">Select captured run</option>
        {runs.map((item) => (
          <option key={item.id} value={item.id}>
            {item.file.split("/").at(-1)} · {new Date(item.startedAt).toLocaleTimeString()} · {item.status}
          </option>
        ))}
      </select>
      {run && run.results.length > 1 ? (
        <select
          aria-label={`Result ${side}`}
          value={result}
          onChange={(event) => {
            setResult(Number(event.target.value));
            setPage(0);
          }}
        >
          {run.results.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: immutable ordinal identifies unnamed captured emissions.
            <option key={`${item.name}:${index}`} value={index}>
              {item.name}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
  const provenance = (run: Run | undefined) =>
    run ? (
      <div className="comparison-provenance">
        <span title={run.file}>{run.file}</span>
        <code>{run.sourceRevision.slice(0, 12)}</code>
        <span>{run.target ?? "unverified target"}</span>
        <code title="Schema">{run.schemaHash?.slice(0, 12) ?? "unknown schema"}</code>
        <span title={run.parameterFingerprint ?? "Bindings were not captured"}>
          {run.parameterCount === undefined ? "bindings unknown" : `${run.parameterCount} bindings`}
          {run.parameterFingerprint ? ` · ${run.parameterFingerprint.slice(0, 10)}` : ""}
        </span>
      </div>
    ) : null;
  const metric = (label: string, aValue: number | null | undefined, bValue: number | null | undefined) => {
    const delta = typeof aValue === "number" && typeof bValue === "number" ? bValue - aValue : null;
    return (
      <div className="comparison-metric" key={label}>
        <span>{label}</span>
        <strong>{milliseconds(aValue)}</strong>
        <strong>{milliseconds(bValue)}</strong>
        <span className={delta !== null ? (delta > 0 ? "slower" : delta < 0 ? "faster" : "") : ""}>
          {delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(2)} ms`}
        </span>
      </div>
    );
  };
  return (
    <section className="comparison-workspace">
      <div className="comparison-toolbar">
        <strong>Compare runs</strong>
        <select
          aria-label="Row comparison mode"
          value={mode}
          onChange={(event) => setMode(event.target.value as typeof mode)}
        >
          <option value="ordered">Ordered rows</option>
          <option value="multiset">Unordered · preserve duplicates</option>
        </select>
        <span className="muted">
          {full ? "Complete captured results" : `Page ${page + 1} only · not full-query equivalence`}
        </span>
      </div>
      <div className="comparison-heads">
        <div>
          {selector("A", leftId, setLeftId, leftResult, setLeftResult, left)}
          {provenance(left)}
        </div>
        <div>
          {selector("B", rightId, setRightId, rightResult, setRightResult, right)}
          {provenance(right)}
        </div>
      </div>
      <div className="comparison-metrics">
        <div className="comparison-metric labels">
          <span>Captured timing</span>
          <span>A</span>
          <span>B</span>
          <span>B − A</span>
        </div>
        {metric("Wall time (incl. wait)", left ? totalTime(left) : null, right ? totalTime(right) : null)}
        {metric("Check", left?.timings?.checkMs, right?.timings?.checkMs)}
        {metric("Build", left?.timings?.buildMs, right?.timings?.buildMs)}
        {metric("Query + fetch (active)", left?.timings?.fetchMs, right?.timings?.fetchMs)}
        <p>
          One captured run each. Active query/fetch excludes checking, startup and paused cursor demand; server
          execution time is unavailable; — means unavailable.
        </p>
      </div>
      <div className="comparison-summary">
        {leftId === rightId && leftId ? (
          <span className="warning-text">Select two different runs.</span>
        ) : difference ? (
          <>
            <span className={difference.sameColumns ? "" : "warning-text"}>
              {difference.sameColumns ? "Column names match" : "Column names differ"}
            </span>
            <span>Values by column position</span>
            <span>
              {difference.typeComparison === "unknown"
                ? "Column types unavailable"
                : difference.typeComparison === "match"
                  ? "Column types match"
                  : "Column types differ"}
            </span>
            <span>{difference.equal} matching rows</span>
            <span>{difference.leftDifferent.size} A-only / changed</span>
            <span>{difference.rightDifferent.size} B-only / changed</span>
          </>
        ) : (
          <span>Select two captured result sets to compare.</span>
        )}
      </div>
      <div className="comparison-grids">
        <div>
          {a.error ? (
            <div className="error-empty">{a.error}</div>
          ) : a.loading ? (
            <div className="quiet-empty">Fetching A…</div>
          ) : leftGrid ? (
            <ResultGrid
              data={leftGrid}
              different={difference?.leftOnly}
              changedCells={difference?.leftCells}
              columnDifferences={difference?.columnDifferences}
              offset={page * (left?.results[leftResult]?.paging?.pageSize ?? 200)}
            />
          ) : (
            <div className="quiet-empty">No tabular result in A.</div>
          )}
        </div>
        <div>
          {b.error ? (
            <div className="error-empty">{b.error}</div>
          ) : b.loading ? (
            <div className="quiet-empty">Fetching B…</div>
          ) : rightGrid ? (
            <ResultGrid
              data={rightGrid}
              different={difference?.rightOnly}
              changedCells={difference?.rightCells}
              columnDifferences={difference?.columnDifferences}
              offset={page * (right?.results[rightResult]?.paging?.pageSize ?? 200)}
            />
          ) : (
            <div className="quiet-empty">No tabular result in B.</div>
          )}
        </div>
      </div>
      <div className="comparison-footer">
        <span>
          {mode === "ordered"
            ? "Highlighted cells changed; highlighted whole rows are missing from the other result."
            : "Highlighted rows are unmatched, including duplicate counts."}{" "}
          Loaded pages only.
        </span>
        <div>
          <button
            type="button"
            disabled={page === 0 || a.loading || b.loading}
            onClick={() => setPage((value) => Math.max(0, value - 1))}
          >
            ‹ Previous
          </button>
          <span>Page {page + 1}</span>
          <button
            type="button"
            disabled={a.loading || b.loading || (!a.data?.nextPage && !b.data?.nextPage)}
            onClick={() => setPage((value) => value + 1)}
          >
            Next ›
          </button>
        </div>
      </div>
    </section>
  );
}
