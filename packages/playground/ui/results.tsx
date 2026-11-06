import { useMemo, useState } from "react";
import { Modal } from "./modal";
import type { Run, Value } from "./types";

function object(value: Value): Map<string, Value> | null {
  return value && typeof value === "object" && value.kind === "object" ? new Map(value.entries) : null;
}
export function valueText(value: Value): string {
  if (value === null) return "NULL";
  if (typeof value !== "object") return String(value);
  if (value.kind === "undefined") return "undefined";
  if (value.kind === "array") return `[${value.items.map(valueText).join(", ")}]`;
  if (value.kind === "object")
    return `{ ${value.entries.map(([key, item]) => `${key}: ${valueText(item)}`).join(", ")} }`;
  if (value.kind === "bigint") return `${value.value}n`;
  return value.value;
}
function grid(
  value: Value,
): { columns: string[]; rows: Value[][]; truncated: boolean; command?: string; affectedRows?: number } | null {
  const data = object(value);
  const columns = data?.get("columns");
  const rows = data?.get("rows");
  if (
    columns &&
    typeof columns === "object" &&
    columns.kind === "array" &&
    rows &&
    typeof rows === "object" &&
    rows.kind === "array"
  )
    return {
      columns: columns.items.map((c, i) => {
        const name = object(c)?.get("name");
        return typeof name === "string" ? name : `column ${i + 1}`;
      }),
      rows: rows.items.map((row) => (row && typeof row === "object" && row.kind === "array" ? row.items : [])),
      truncated: data?.get("truncated") === true,
      ...(typeof data?.get("command") === "string" ? { command: data.get("command") as string } : {}),
      ...(typeof data?.get("affectedRows") === "number" ? { affectedRows: data.get("affectedRows") as number } : {}),
    };
  if (value && typeof value === "object" && value.kind === "array" && value.items.every((row) => object(row))) {
    const names = [...new Set(value.items.flatMap((row) => [...object(row)!.keys()]))];
    return {
      columns: names,
      rows: value.items.map((row) =>
        names.map((key) => (object(row)!.has(key) ? object(row)!.get(key)! : { kind: "undefined" })),
      ),
      truncated: false,
    };
  }
  return null;
}
function jsonValue(value: Value): unknown {
  if (!value || typeof value !== "object") return value;
  if (value.kind === "array") return value.items.map(jsonValue);
  if (value.kind === "object") return Object.fromEntries(value.entries.map(([key, item]) => [key, jsonValue(item)]));
  if (value.kind === "date") return value.value;
  if (value.kind === "undefined") return { $type: "undefined" };
  return { $type: value.kind, value: value.value };
}
function download(name: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function ResultPanel({
  run,
  file,
  revision,
  dirty,
}: {
  run: Run | undefined;
  file: string;
  revision: string | null;
  dirty: boolean;
}) {
  const [tab, setTab] = useState("0");
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ column: number; descending: boolean } | null>(null);
  const [scroll, setScroll] = useState(0);
  const [inspect, setInspect] = useState<Value | undefined>();
  const result = run?.results[Number(tab)];
  const data = useMemo(() => (result ? grid(result.value) : null), [result]);
  const rows = useMemo(() => {
    let selected = (data?.rows ?? []).filter(
      (row) => !filter || row.some((value) => valueText(value).toLowerCase().includes(filter.toLowerCase())),
    );
    if (sort)
      selected = selected.toSorted(
        (a, b) =>
          valueText(a[sort.column] ?? null).localeCompare(valueText(b[sort.column] ?? null), undefined, {
            numeric: true,
          }) * (sort.descending ? -1 : 1),
      );
    return selected;
  }, [data, filter, sort]);
  const columnModels = useMemo(
    () => data?.columns.map((name, ordinal) => ({ name, ordinal, key: `column-${ordinal}` })) ?? [],
    [data],
  );
  const rowKeys = useMemo(() => new Map(data?.rows.map((row, ordinal) => [row, `row-${ordinal}`]) ?? []), [data]);
  const resultModels =
    run?.results.map((item, ordinal) => ({ ...item, ordinal, key: `${run.id}:result-${ordinal}` })) ?? [];
  const start = Math.max(0, Math.floor(scroll / 34) - 4);
  const end = Math.min(rows.length, start + 28);
  const exportRows = (format: "json" | "csv") => {
    if (!result) return;
    if (format === "json")
      download(
        "query-result.json",
        JSON.stringify(
          data ? { columns: data.columns, rows: rows.map((row) => row.map(jsonValue)) } : jsonValue(result.value),
          null,
          2,
        ),
        "application/json",
      );
    else if (data) {
      const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
      download(
        "query-result.csv",
        [
          data.columns.map(cell).join(","),
          ...rows.map((row) => row.map((value) => cell(valueText(value))).join(",")),
        ].join("\r\n"),
        "text/csv",
      );
    }
  };
  return (
    <section className="result-panel" aria-label="Execution results">
      {run ? (
        <div className="result-source">
          <span>
            <strong>{run.file}</strong> · {run.mode} · source {run.sourceRevision.slice(0, 12)}
          </span>
          <span className={run.file !== file || run.sourceRevision !== revision || dirty ? "stale-result" : ""}>
            {run.file !== file || run.sourceRevision !== revision || dirty
              ? "Earlier source result — run the current file to refresh"
              : "Matches saved source"}
          </span>
        </div>
      ) : null}
      <div className="result-tabs">
        <div>
          {resultModels.map((item) => (
            <button
              type="button"
              className={tab === String(item.ordinal) ? "active" : ""}
              key={item.key}
              onClick={() => {
                setTab(String(item.ordinal));
                setScroll(0);
              }}
            >
              {item.name}
              <span>{grid(item.value)?.rows.length ?? "·"}</span>
            </button>
          ))}
          <button type="button" className={tab === "log" ? "active" : ""} onClick={() => setTab("log")}>
            Run log
          </button>
        </div>
        <span className={`run-status ${run?.status ?? ""}`}>{run?.status ?? "Ready to run"}</span>
      </div>
      {!run ? (
        <div className="empty-results">
          <span className="large-symbol">↳</span>
          <strong>Your data, next to your code.</strong>
          <p>
            Save a query and run it to inspect live results.
            <br />
            Static types stay visible before you connect.
          </p>
        </div>
      ) : tab === "log" ? (
        <div className="log-pane">
          <small>
            {run.file} · {run.mode} · {run.sourceRevision.slice(0, 12)}
          </small>
          <pre>{run.logs || "No console output."}</pre>
          {run.error ? (
            <pre className="error-detail">
              {run.error.code}: {run.error.message}
            </pre>
          ) : null}
        </div>
      ) : result ? (
        <>
          <div className="result-tools">
            <div>
              <b>{rows.length}</b> fetched rows{" "}
              {data?.command ? (
                <span>
                  · {data.command}
                  {data.affectedRows === undefined ? "" : ` · ${data.affectedRows} affected`}
                </span>
              ) : null}{" "}
              <span>
                · {result.provenance === "managed" ? "managed target verified" : "database target not verified"}
              </span>
              {data?.truncated || result.truncated ? <b className="warning"> · Truncated</b> : null}
            </div>
            <div>
              <input
                aria-label="Filter fetched rows"
                placeholder="Filter fetched rows…"
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value);
                  setScroll(0);
                }}
              />
              <button type="button" onClick={() => exportRows("json")}>
                JSON ↓
              </button>
              <button type="button" disabled={!data} onClick={() => exportRows("csv")}>
                CSV ↓
              </button>
            </div>
          </div>
          {data ? (
            <div className="grid-scroll" onScroll={(event) => setScroll(event.currentTarget.scrollTop)}>
              <table className="data-grid">
                <thead>
                  <tr>
                    <th className="row-number">#</th>
                    {columnModels.map((column) => (
                      <th key={column.key}>
                        <button
                          type="button"
                          onClick={() =>
                            setSort((current) => ({
                              column: column.ordinal,
                              descending: current?.column === column.ordinal ? !current.descending : false,
                            }))
                          }
                        >
                          {column.name} {sort?.column === column.ordinal ? (sort.descending ? "↓" : "↑") : "↕"}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {start > 0 ? (
                    <tr style={{ height: start * 34 }}>
                      <td colSpan={data.columns.length + 1} />
                    </tr>
                  ) : null}
                  {rows.slice(start, end).map((row, index) => (
                    <tr key={rowKeys.get(row)}>
                      <td className="row-number">{start + index + 1}</td>
                      {columnModels.map((column) => {
                        const value =
                          column.ordinal < row.length ? row[column.ordinal]! : { kind: "undefined" as const };
                        return (
                          <td key={column.key}>
                            <button
                              type="button"
                              className={`cell ${value === null ? "null" : ""}`}
                              onClick={() => setInspect(value)}
                              onDoubleClick={() => void navigator.clipboard.writeText(valueText(value))}
                              title="Inspect value; double-click to copy"
                            >
                              {valueText(value).slice(0, 180)}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {end < rows.length ? (
                    <tr style={{ height: (rows.length - end) * 34 }}>
                      <td colSpan={data.columns.length + 1} />
                    </tr>
                  ) : null}
                </tbody>
              </table>
              {!rows.length ? <div className="no-rows">Query returned no rows.</div> : null}
            </div>
          ) : (
            <pre className="structured-result">{JSON.stringify(jsonValue(result.value), null, 2)}</pre>
          )}
        </>
      ) : (
        <div className="empty-results">
          <strong>
            {run.status === "checking"
              ? "Checking your project…"
              : run.status === "running"
                ? "Running on your selected target…"
                : run.error
                  ? "Run needs attention"
                  : "No result sets emitted"}
          </strong>
          <p>{run.error?.message ?? "Use the Run log for console output and completion details."}</p>
          {run.error ? (
            <button type="button" onClick={() => setTab("log")}>
              Open run log
            </button>
          ) : null}
        </div>
      )}
      {inspect !== undefined ? (
        <Modal className="value-dialog" label="Inspect value" onClose={() => setInspect(undefined)}>
          <header>
            <strong>Value inspector</strong>
            <button type="button" onClick={() => setInspect(undefined)}>
              Close
            </button>
          </header>
          <pre>{JSON.stringify(jsonValue(inspect), null, 2)}</pre>
          <button type="button" onClick={() => void navigator.clipboard.writeText(valueText(inspect))}>
            Copy value
          </button>
        </Modal>
      ) : null}
    </section>
  );
}
