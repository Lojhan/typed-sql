import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { Icon } from "./icon";
import { Modal } from "./modal";
import { type Grid, jsonValue, milliseconds, resultGrid, totalTime, valueText } from "./result-model";
import type { Run, Value } from "./types";

export { valueText } from "./result-model";
export interface ResultPage {
  value: Value;
  hasPage?: boolean;
  page: number;
  nextPage: number | null;
  complete: boolean;
  rowCount: number;
}
const pageCache = new Map<string, ResultPage>();
const requests = new Map<string, Promise<ResultPage>>();
function fetchPage(identity: string, route: string) {
  const existing = requests.get(identity);
  if (existing) return existing;
  const request = api<ResultPage>(route)
    .then((value) => {
      pageCache.set(identity, value);
      while (pageCache.size > 24) pageCache.delete(pageCache.keys().next().value!);
      return value;
    })
    .finally(() => requests.delete(identity));
  requests.set(identity, request);
  return request;
}
export function useResultPage(run: Run | undefined, resultIndex: number, page: number) {
  const result = run?.results[resultIndex];
  const [state, setState] = useState<{ identity: string; data?: ResultPage; error?: string; loading: boolean }>({
    identity: "",
    loading: false,
  });

  const identity = `${run?.id ?? ""}:${result?.paging?.id ?? resultIndex}:${page}`;
  useEffect(() => {
    if (!run || !result) {
      setState({ identity, loading: false });
      return;
    }
    if (page === 0) {
      setState({
        identity,
        loading: false,
        data: {
          value: result.value,
          page: 0,
          nextPage:
            result.paging && !result.paging.complete ? 1 : result.paging && result.paging.pageCount > 1 ? 1 : null,
          complete: result.paging?.complete ?? !result.truncated,
          rowCount: result.paging?.rowCount ?? resultGrid(result.value)?.rows.length ?? 0,
        },
      });
      return;
    }
    if (!result.paging) {
      setState({ identity, loading: false, error: "This result has no additional captured pages." });
      return;
    }
    if (result.paging.complete && page >= result.paging.pageCount) {
      setState({
        identity,
        loading: false,
        data: {
          value: { kind: "array", items: [] },
          hasPage: false,
          page,
          nextPage: null,
          complete: true,
          rowCount: result.paging.rowCount,
        },
      });
      return;
    }
    const previous = pageCache.get(identity);
    if (previous) {
      setState({ identity, loading: false, data: previous });
      return;
    }
    let cancelled = false;
    setState({ identity, loading: true });
    void fetchPage(
      identity,
      `results?run=${encodeURIComponent(run.id)}&result=${encodeURIComponent(result.paging.id)}&page=${page}`,
    ).then(
      (data) => {
        if (cancelled) return;

        setState({ identity, loading: false, data });
      },
      (error) => {
        if (!cancelled) setState({ identity, loading: false, error: error.message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [identity, page, run, result]);
  const active = state.identity === identity ? state : { identity, loading: true };
  if (!active.data || !result?.paging) return active;
  const complete = result.paging.complete || active.data.complete;
  const rowCount = Math.max(result.paging.rowCount, active.data.rowCount);
  return {
    ...active,
    data: {
      ...active.data,
      complete,
      rowCount,
      nextPage:
        active.data.hasPage === false
          ? null
          : page + 1 < result.paging.pageCount || (!complete && run?.status === "running")
            ? page + 1
            : null,
    },
  };
}
export function ResultGrid({
  data,
  offset = 0,
  different,
  changedCells,
  columnDifferences,
  filter = "",
  sort = null,
  onInspect,
  onEnd,
}: {
  data: Grid;
  offset?: number;
  different?: ReadonlySet<number> | undefined;
  changedCells?: ReadonlyMap<number, ReadonlySet<number>> | undefined;
  columnDifferences?: ReadonlySet<number> | undefined;
  filter?: string;
  sort?: { column: number; descending: boolean } | null;
  onInspect?: (value: Value) => void;
  onEnd?: () => void;
}) {
  const [scroll, setScroll] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const previousOffset = useRef(offset);
  useEffect(() => {
    const delta = offset - previousOffset.current;
    if (scroller.current && delta > 0)
      scroller.current.scrollTop = Math.max(0, scroller.current.scrollTop - delta * 30);
    previousOffset.current = offset;
  }, [offset]);
  const models = useMemo(() => data.rows.map((row, index) => ({ row, index, key: `row-${index}` })), [data]);
  const rows = useMemo(() => {
    let selected = models.filter(
      ({ row }) => !filter || row.some((value) => valueText(value).toLowerCase().includes(filter.toLowerCase())),
    );
    if (sort)
      selected = selected.toSorted(
        (a, b) =>
          valueText(a.row[sort.column] ?? null).localeCompare(valueText(b.row[sort.column] ?? null), undefined, {
            numeric: true,
          }) * (sort.descending ? -1 : 1),
      );
    return selected;
  }, [models, filter, sort]);
  const columns = useMemo(() => data.columns.map((name, index) => ({ name, index, key: `column-${index}` })), [data]);
  const start = Math.max(0, Math.floor(scroll / 30) - 5),
    end = Math.min(rows.length, start + 35);
  return (
    <div
      className="grid-scroll"
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        setScroll(element.scrollTop);
        if (element.scrollHeight - element.scrollTop - element.clientHeight < 160) onEnd?.();
      }}
    >
      <table className="data-grid">
        <thead>
          <tr>
            <th className="row-number">#</th>
            {columns.map((column) => (
              <th
                key={column.key}
                className={columnDifferences?.has(column.index) ? "column-mismatch" : ""}
                title={`${column.name}${data.columnTypes?.[column.index] ? ` · ${data.columnTypes[column.index]}` : ""}`}
              >
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {start > 0 ? (
            <tr style={{ height: start * 30 }}>
              <td colSpan={columns.length + 1} />
            </tr>
          ) : null}
          {rows.slice(start, end).map(({ row, index, key }) => (
            <tr className={different?.has(index) ? "diff-row" : ""} key={key}>
              <td className="row-number">{offset + index + 1}</td>
              {columns.map((column) => {
                const value = column.index < row.length ? row[column.index]! : { kind: "undefined" as const };
                return (
                  <td key={column.key} className={changedCells?.get(index)?.has(column.index) ? "diff-cell" : ""}>
                    <button
                      type="button"
                      className={`cell ${value === null ? "null" : ""}`}
                      title={valueText(value)}
                      onClick={() => onInspect?.(value)}
                    >
                      {valueText(value).slice(0, 180)}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
          {end < rows.length ? (
            <tr style={{ height: (rows.length - end) * 30 }}>
              <td colSpan={columns.length + 1} />
            </tr>
          ) : null}
        </tbody>
      </table>
      {!rows.length ? <div className="quiet-empty">No rows.</div> : null}
    </div>
  );
}
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function ResultPanel({
  run,
  file,
  revision,
  dirty,
  schemaHash,
  typePolicyHash,
  onCompare,
}: {
  run: Run | undefined;
  file: string;
  revision: string | null;
  dirty: boolean;
  schemaHash: string;
  typePolicyHash: string;
  onCompare?: (id: string) => void;
}) {
  const [index, setIndex] = useState(0),
    [page, setPage] = useState(0),
    [filter, setFilter] = useState(""),
    [log, setLog] = useState(false),
    [inspect, setInspect] = useState<Value | undefined>(),
    [localError, setLocalError] = useState("");
  const scrollDemand = useRef(false);
  const result = run?.results[index];
  const captured = useResultPage(run, index, page);
  const [windowPages, setWindowPages] = useState<{ page: number; grid: Grid }[]>([]);
  const pageValue = captured.data?.value;
  const pageHasValue = captured.data?.hasPage !== false;
  const pageGrid = useMemo(
    () => (pageValue !== undefined && pageHasValue ? resultGrid(pageValue) : null),
    [pageValue, pageHasValue],
  );
  useEffect(() => {
    if (!pageGrid) return;
    setWindowPages((previous) => {
      if (previous.some((item) => item.page === page && item.grid === pageGrid)) return previous;
      return [...previous.filter((item) => item.page !== page), { page, grid: pageGrid }]
        .sort((a, b) => a.page - b.page)
        .slice(-5);
    });
  }, [pageGrid, page]);
  const data = useMemo(
    () =>
      windowPages.length
        ? { ...windowPages[0]!.grid, rows: windowPages.flatMap((item) => item.grid.rows) }
        : captured.data
          ? resultGrid(captured.data.value)
          : null,
    [windowPages, captured.data?.value, captured.data],
  );
  const firstPage = windowPages[0]?.page ?? page;
  useEffect(() => {
    if (!captured.loading) scrollDemand.current = false;
  }, [captured.loading]);
  const stale =
    run &&
    (run.file !== file ||
      run.sourceRevision !== revision ||
      dirty ||
      run.schemaHash !== schemaHash ||
      run.typePolicyHash !== typePolicyHash);
  const exportPage = (format: "json" | "csv") => {
    if (!captured.data) return;
    if (format === "json")
      download(
        "query-loaded-rows.json",
        JSON.stringify(
          data
            ? { columns: data.columns, rows: data.rows.map((row) => row.map(jsonValue)) }
            : jsonValue(captured.data.value),
          null,
          2,
        ),
        "application/json",
      );
    else if (data) {
      const csvEscape = (value: string) => `"${value.replaceAll('"', '""')}"`;
      download(
        "query-loaded-rows.csv",
        [
          data.columns.map(csvEscape).join(","),
          ...data.rows.map((row) => row.map((value) => csvEscape(valueText(value))).join(",")),
        ].join("\r\n"),
        "text/csv",
      );
    }
  };
  const complete = captured.data?.complete ?? result?.paging?.complete ?? false;
  const total = captured.data?.rowCount ?? result?.paging?.rowCount ?? data?.rows.length ?? 0;
  const next = captured.data?.nextPage !== null && captured.data?.nextPage !== undefined;
  return (
    <section className="result-panel" aria-label="Query results">
      <div className="result-controls">
        <div className="result-control-left">
          {run ? (
            <>
              <span className={`status-dot ${run.status}`} />
              <span className="run-label" title={`${run.file} · ${run.sourceRevision}`}>
                {run.file.split("/").at(-1)}
              </span>
              <span className="provenance" title={`${run.target ?? "unverified target"} · ${run.sourceRevision}`}>
                {run.sourceRevision.slice(0, 8)} · {run.target ?? "unverified"}
              </span>
              <span className="muted">{milliseconds(totalTime(run))}</span>
              {stale ? (
                <span className="stale-label" title="Result belongs to an earlier source or schema">
                  stale
                </span>
              ) : null}
              {run.results.length > 1 ? (
                <select
                  aria-label="Result set"
                  value={index}
                  onChange={(event) => {
                    setIndex(Number(event.target.value));
                    setPage(0);
                    setWindowPages([]);
                    setLocalError("");
                  }}
                >
                  {run.results.map((item, ordinal) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: emission ordinal is immutable captured result identity.
                    <option key={`${item.name}:${ordinal}`} value={ordinal}>
                      {item.name}
                    </option>
                  ))}
                </select>
              ) : null}
            </>
          ) : (
            <span className="muted">No execution</span>
          )}
        </div>
        <div className="result-control-right">
          <button type="button" className={log ? "selected" : ""} onClick={() => setLog((value) => !value)}>
            Log
          </button>
          {run && onCompare ? (
            <button type="button" onClick={() => onCompare(run.id)}>
              Compare
            </button>
          ) : null}
          <button type="button" disabled={!captured.data} onClick={() => exportPage("json")}>
            JSON
          </button>
          <button type="button" disabled={!data} onClick={() => exportPage("csv")}>
            CSV
          </button>
        </div>
      </div>
      {log ? (
        <div className="run-log">
          <pre>{run?.logs || "No console output."}</pre>
          {run?.error ? (
            <pre className="error-text">
              {run.error.code}: {run.error.message}
            </pre>
          ) : null}
        </div>
      ) : captured.loading && !data ? (
        <div className="quiet-empty">Fetching page…</div>
      ) : captured.error || localError ? (
        <div className="error-empty">{captured.error || localError}</div>
      ) : data ? (
        <>
          <div className="result-filter">
            <input
              aria-label="Filter loaded result rows"
              value={filter}
              placeholder="Filter loaded rows"
              onChange={(event) => setFilter(event.target.value)}
            />
            <span>
              {data.command ?? result?.name}
              {data.affectedRows === undefined ? "" : ` · ${data.affectedRows} affected`}
              {result?.truncated ? " · truncated" : ""}
            </span>
          </div>
          <ResultGrid
            data={data}
            offset={firstPage * (result?.paging?.pageSize ?? data.rows.length)}
            onEnd={() => {
              if (!captured.loading && next && !scrollDemand.current) {
                scrollDemand.current = true;
                setPage((value) => value + 1);
              }
            }}
            filter={filter}
            onInspect={setInspect}
          />
        </>
      ) : captured.data ? (
        <pre className="structured-result">{JSON.stringify(jsonValue(captured.data.value), null, 2)}</pre>
      ) : (
        <div className="quiet-empty">
          {run?.error ? (
            <span className="error-text">{run.error.message}</span>
          ) : run && ["checking", "running", "cancelling"].includes(run.status) ? (
            `${run.status}…`
          ) : (
            "No result set."
          )}
        </div>
      )}
      {run && result && !log ? (
        <div className="result-pager">
          <span>
            {data?.rows.length
              ? `${firstPage * (result.paging?.pageSize ?? data.rows.length) + 1}–${firstPage * (result.paging?.pageSize ?? data.rows.length) + data.rows.length}`
              : "0"}{" "}
            of {complete ? "" : "≥"}
            {total}
            {!complete ? " · partial capture" : ""}
            <span className="provenance"> · {result.provenance === "managed" ? "managed" : "target unverified"}</span>
          </span>
          <div>
            {result.paging && !complete && run.status === "running" ? (
              <button
                type="button"
                onClick={() =>
                  void api("results/close", { run: run.id, result: result.paging!.id }).catch((error) =>
                    setLocalError(error.message),
                  )
                }
              >
                Close cursor
              </button>
            ) : null}
            <button
              type="button"
              disabled={firstPage === 0 || captured.loading}
              onClick={() => {
                setWindowPages([]);
                setPage(Math.max(0, firstPage - 1));
              }}
              aria-label="Previous result page"
            >
              ‹
            </button>
            <span>
              {windowPages.length > 1
                ? `Pages ${firstPage + 1}–${(windowPages.at(-1)?.page ?? firstPage) + 1}`
                : `Page ${(windowPages.at(-1)?.page ?? firstPage) + 1}`}
            </span>
            <button
              type="button"
              disabled={captured.loading || (!next && !(result.paging && !complete && run.status === "running"))}
              onClick={() => setPage((value) => value + 1)}
              aria-label="Next result page"
            >
              ›
            </button>
          </div>
        </div>
      ) : null}
      {inspect !== undefined ? (
        <Modal className="value-dialog" label="Inspect value" onClose={() => setInspect(undefined)}>
          <header>
            <strong>Value</strong>
            <button type="button" onClick={() => setInspect(undefined)}>
              <Icon name="close" />
            </button>
          </header>
          <pre>{JSON.stringify(jsonValue(inspect), null, 2)}</pre>
          <button type="button" onClick={() => void navigator.clipboard.writeText(valueText(inspect))}>
            Copy
          </button>
        </Modal>
      ) : null}
    </section>
  );
}
