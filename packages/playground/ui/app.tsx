import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SchemaBoard } from "./board";
import { Editor } from "./editor";
import { Modal } from "./modal";
import { ResultPanel } from "./results";
import type { Analysis, State, Table, Value } from "./types";
import "./style.css";

const fragment = new URLSearchParams(location.hash.slice(1));
const token = fragment.get("session") ?? sessionStorage.getItem("typed-sql-session") ?? "";
if (fragment.has("session")) {
  sessionStorage.setItem("typed-sql-session", token);
  history.replaceState(null, "", location.pathname);
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-typed-sql-session": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "Request failed");
  return result as T;
}
function App() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<"schema" | "editor">("schema");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState("");
  const [source, setSource] = useState("");
  const [savedSource, setSavedSource] = useState("");
  const [revision, setRevision] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [mode, setMode] = useState<"export" | "file" | "sql">("export");
  const [exportName, setExportName] = useState("run");
  const [readOnly, setReadOnly] = useState(true);
  const [parameters, setParameters] = useState<Record<number, { value: string; null: boolean }>>({});
  const [inspector, setInspector] = useState<"types" | "parameters" | "schema">("types");
  const [showTrust, setShowTrust] = useState(false);
  const [create, setCreate] = useState<{ table?: Table; path: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const selectionGeneration = useRef(0);
  const stateRef = useRef<State | null>(null);
  const etag = useRef("");
  const dirty = source !== savedSource;
  const active = state?.runs.find((run) => ["checking", "running", "cancelling"].includes(run.status));
  const selectedTable = state?.board.tables.find((table) => table.id === selected);
  const refresh = useCallback(async () => {
    const current = stateRef.current;
    const query = new URLSearchParams();
    if (current) {
      query.set("catalog", current.schemaHash);
      query.set("results", current.runs.map((run) => `${run.id}:${run.results.length}`).join(","));
    }
    const response = await fetch(`/api/state?${query}`, {
      headers: { "x-typed-sql-session": token, ...(etag.current ? { "if-none-match": etag.current } : {}) },
    });
    if (response.status === 304) return;
    if (!response.ok) throw new Error("Cannot read workspace state; reopen the printed local session URL.");
    etag.current = response.headers.get("etag") ?? "";
    const next = (await response.json()) as State;
    next.board = next.board ?? current?.board;
    next.runs = next.runs.map((run) => ({
      ...run,
      results: run.results ?? current?.runs.find((previous) => previous.id === run.id)?.results ?? [],
    }));
    stateRef.current = next;
    setState(next);
  }, []);
  useEffect(() => {
    void refresh().catch((error) => setError(String(error.message)));
    const timer = setInterval(() => void refresh().catch((error) => setError(String(error.message))), 1000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty]);
  useEffect(() => {
    if (!file) return;
    const current = ++generation.current;
    const timer = setTimeout(
      () =>
        void api<Analysis>("analyze", { file, source }).then(
          (result) => {
            if (current === generation.current) setAnalysis(result);
          },
          (error) => {
            if (current === generation.current)
              setAnalysis({
                revision: "",
                queries: [],
                exports: [],
                diagnostics: [
                  { code: "ANALYSIS", severity: "error", message: error.message, range: { line: 1, column: 1 } },
                ],
              });
          },
        ),
      350,
    );
    return () => clearTimeout(timer);
  }, [file, source]);
  const action = async (task: () => Promise<void>) => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await task();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const openFile = async (path: string) => {
    if (dirty && !confirm("Discard unsaved edits and open another file?")) return;
    const selectedGeneration = ++selectionGeneration.current;
    const next = await api<{ file: string; source: string; revision: string }>("file", { file: path });
    if (selectionGeneration.current !== selectedGeneration) return;
    generation.current++;
    setAnalysis(null);
    setFile(path);
    setSource(next.source);
    setSavedSource(next.source);
    setRevision(next.revision);
    setMode(path.endsWith(".sql") ? "sql" : "export");
    setParameters({});
    setView("editor");
  };
  const save = async () => {
    if (!file) return null;
    const saved = await api<{ revision: string }>("save", { file, source, revision });
    setRevision(saved.revision);
    setSavedSource(source);
    return saved.revision;
  };
  const run = async () => {
    if (!file || !state?.target) return;
    if (mode !== "sql" && !state.trusted) {
      setShowTrust(true);
      return;
    }
    if (state.executionSchemaStale)
      throw new Error(
        "Live schema differs from the saved compiler snapshot. Generate the updated contract and restart before execution.",
      );
    const saved = await save();
    if (!saved) return;
    const values: Value[] = [];
    if (mode === "sql") {
      const count = analysis?.queries[0]?.parameterCount ?? 0;
      for (let index = 1; index <= count; index++) {
        const input = parameters[index];
        const expected = analysis?.queries[0]?.parameters?.find((p) => p.index === index);
        if (input?.null) {
          if (expected && !expected.nullable) throw new Error(`Parameter ${index} does not accept NULL`);
          values.push(null);
          continue;
        }
        if (input?.value === undefined || input.value === "") throw new Error(`Enter a value for parameter ${index}`);
        if (expected?.tsType === "number") {
          const value = Number(input.value);
          if (!Number.isFinite(value)) throw new Error(`Parameter ${index} must be a finite number`);
          values.push(value);
        } else if (expected?.tsType === "bigint") {
          if (!/^-?\d+$/.test(input.value)) throw new Error(`Parameter ${index} must be an integer`);
          values.push({ kind: "bigint", value: input.value });
        } else if (expected?.tsType === "boolean") {
          if (!["true", "false"].includes(input.value)) throw new Error(`Parameter ${index} must be true or false`);
          values.push(input.value === "true");
        } else if (expected?.tsType === "Date") {
          const value = new Date(input.value);
          if (!Number.isFinite(value.getTime())) throw new Error(`Parameter ${index} requires an ISO date/time`);
          values.push({ kind: "date", value: value.toISOString() });
        } else values.push(input.value);
      }
    }
    await api("run", { requestId: crypto.randomUUID(), file, revision: saved, mode, exportName, readOnly, values });
    await refresh();
  };
  const newFile = async () => {
    if (!create) return;
    if (create.table) await api("create-query", { table: create.table.id, file: create.path });
    else
      await api("save", {
        file: create.path,
        source: create.path.endsWith(".sql")
          ? "-- Write a parameterized SQL statement here.\n"
          : "export async function run() {\n  return [];\n}\n",
        revision: null,
      });
    const path = create.path;
    setCreate(null);
    await refresh();
    await openFile(path);
  };
  if (!state)
    return (
      <main className="boot">
        <div className="brand-mark">t/</div>
        <h1>typed-sql workspace</h1>
        <p>{error || "Opening your project…"}</p>
        {error ? (
          <button type="button" onClick={() => void action(refresh)}>
            Retry
          </button>
        ) : null}
      </main>
    );
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">t/</span>
          <strong>typed-sql</strong>
          <span className="divider" />
          <span>dev workspace</span>
          <span className="preview-chip">LOCAL</span>
        </div>
        <div className="top-actions">
          <span className={`connection-dot ${state.connection.state === "connected" ? "online" : ""}`} />
          <span>{state.connection.identity?.database ?? state.target ?? "Offline analysis"}</span>
          <span className="classification">{state.classification ?? state.grammar}</span>
          <button
            type="button"
            disabled={busy || !!active}
            onClick={() =>
              void action(async () => {
                await api(state.connection.state === "connected" ? "refresh" : "connect", {});
                await refresh();
              })
            }
          >
            {state.connection.state === "connected" ? "↻ Refresh schema" : "Connect database"}
          </button>
        </div>
      </header>
      <div className="projectbar">
        <div>
          <span className="project-icon">▱</span>
          <strong>{state.project.name}</strong>
          <span className="muted">/ {state.project.config}</span>
        </div>
        <div className="project-meta">
          <span>{state.grammar}</span>
          <span>Schema {state.schemaSource === "live" ? "captured live" : "from snapshot"}</span>
          <span title={state.schemaHash}>{state.schemaHash.slice(0, 12)}</span>
        </div>
      </div>
      {error ? (
        <div className="banner error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      ) : null}
      {state.executionSchemaStale ? (
        <div className="banner error" role="status">
          Live schema differs from the saved compiler contract. Analysis uses the live catalog; execution is blocked
          until you generate the contract and restart.
        </div>
      ) : null}
      {notice ? (
        <div className="banner notice" role="status">
          {notice}
        </div>
      ) : null}
      <div className="workspace-body">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <span>EXPLORER</span>
            <button
              type="button"
              title="Create a query file"
              aria-label="Create a query file"
              onClick={() => setCreate({ path: `${state.scratchDirectory}/query.ts` })}
            >
              +
            </button>
          </div>
          <label className="search">
            <span>⌕</span>
            <input
              aria-label="Search schema and files"
              placeholder="Find tables, columns, files…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <kbd>⌕</kbd>
          </label>
          <div className="section-label">
            SCHEMA <span>{state.board.tables.length}</span>
          </div>
          <nav className="table-list" aria-label="Schema relations">
            {state.board.tables
              .filter((table) =>
                `${table.namespace}.${table.name} ${table.columns.map((c) => c.name).join(" ")}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((table) => (
                <button
                  type="button"
                  className={selected === table.id ? "selected" : ""}
                  key={table.id}
                  onClick={() => {
                    setSelected(table.id);
                    setInspector("schema");
                    setView("schema");
                  }}
                >
                  <span className="table-glyph">▦</span>
                  <span>
                    {table.name}
                    <small>{table.namespace || "default"}</small>
                  </span>
                  <span className="list-count">{table.columns.length}</span>
                </button>
              ))}
          </nav>
          <div className="section-label files-label">
            QUERY FILES{" "}
            <button type="button" onClick={() => setCreate({ path: `${state.scratchDirectory}/query.ts` })}>
              +
            </button>
          </div>
          <div className="file-list">
            {state.files
              .filter((path) => path.toLowerCase().includes(search.toLowerCase()))
              .map((path) => (
                <button
                  type="button"
                  className={file === path ? "selected" : ""}
                  key={path}
                  onClick={() => void action(() => openFile(path))}
                >
                  <span className={path.endsWith(".sql") ? "sql-icon" : "ts-icon"}>
                    {path.endsWith(".sql") ? "SQL" : "TS"}
                  </span>
                  <span title={path}>
                    {path.split("/").at(-1)}
                    <small>{path.split("/").slice(0, -1).join("/")}</small>
                  </span>
                  {file === path && dirty ? <i className="dirty-dot" /> : null}
                </button>
              ))}
            {!state.files.length ? (
              <p className="sidebar-empty">
                Your queries live in your project.
                <br />
                <button type="button" onClick={() => setCreate({ path: `${state.scratchDirectory}/query.ts` })}>
                  Create your first file →
                </button>
              </p>
            ) : null}
          </div>
          <footer className="sidebar-footer">
            <span className="connection-dot" />
            Local project · no cloud account
          </footer>
        </aside>
        <main className="main-area">
          <div className="workspace-tabs">
            <div>
              <button type="button" className={view === "schema" ? "active" : ""} onClick={() => setView("schema")}>
                ⌘ Schema board
              </button>
              <button type="button" className={view === "editor" ? "active" : ""} onClick={() => setView("editor")}>
                ⌁ Query workspace{dirty ? <i className="dirty-dot" /> : null}
              </button>
            </div>
            <span>{state.board.edges.length} captured relationships</span>
          </div>
          <div className={`workbench ${view === "schema" ? "board-mode" : ""}`}>
            <div className="primary-pane">
              {view === "schema" ? (
                <SchemaBoard
                  board={state.board}
                  selected={selected}
                  onSelect={(id) => {
                    setSelected(id);
                    setInspector("schema");
                  }}
                  search={search}
                  identity={`${state.project.name}:${state.target ?? "offline"}`}
                />
              ) : (
                <>
                  <div className="editor-toolbar">
                    <div>
                      <span className={file.endsWith(".sql") ? "sql-icon" : "ts-icon"}>
                        {file.endsWith(".sql") ? "SQL" : "TS"}
                      </span>
                      <strong>{file || "No query selected"}</strong>
                      {dirty ? <span className="unsaved">Unsaved</span> : null}
                    </div>
                    <div>
                      <button
                        type="button"
                        disabled={!file || busy}
                        onClick={() =>
                          void action(async () => {
                            await save();
                            setNotice("File saved.");
                          })
                        }
                      >
                        Save <kbd>⌘S</kbd>
                      </button>
                      <button
                        type="button"
                        disabled={!file || busy}
                        onClick={() => {
                          const path = prompt("Save as project-relative path", file);
                          if (path)
                            void action(async () => {
                              await api("save", { file: path, source, revision: null });
                              await refresh();
                              await openFile(path);
                            });
                        }}
                      >
                        Save as
                      </button>
                      {file.endsWith(".sql") ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void action(async () => {
                              const saved = await save();
                              if (!saved) return;
                              const output = await api<{ file: string }>("sql-types", { file, revision: saved });
                              await refresh();
                              setNotice(
                                `Generated ${output.file}. Import the SQL file from TypeScript; regenerate after SQL edits.`,
                              );
                            })
                          }
                        >
                          Generate TS types
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {file ? (
                    <Editor
                      file={file}
                      source={source}
                      onChange={setSource}
                      onSave={() =>
                        void action(async () => {
                          await save();
                        })
                      }
                      onRun={() => void action(run)}
                    />
                  ) : (
                    <div className="editor-empty">
                      <span className="large-symbol">{`{ }`}</span>
                      <h2>A query is just a file.</h2>
                      <p>
                        Create a TypeScript or SQL file, use your project's imports,
                        <br />
                        and keep types, parameters, and live results together.
                      </p>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => setCreate({ path: `${state.scratchDirectory}/query.ts` })}
                      >
                        + Create query file
                      </button>
                    </div>
                  )}
                  <div className="run-toolbar">
                    <div>
                      <select
                        aria-label="Execution mode"
                        value={mode}
                        disabled={file.endsWith(".sql")}
                        onChange={(event) => setMode(event.target.value as "export" | "file" | "sql")}
                      >
                        <option value="export">Named export</option>
                        <option value="file">Full file</option>
                        <option value="sql">SQL statement</option>
                      </select>
                      {mode === "export" ? (
                        <select
                          aria-label="Exported function"
                          value={exportName}
                          onChange={(event) => setExportName(event.target.value)}
                        >
                          {(analysis?.exports.length ? analysis.exports : ["run"]).map((name) => (
                            <option key={name}>{name}</option>
                          ))}
                        </select>
                      ) : null}
                      <label className="readonly-toggle">
                        <input
                          type="checkbox"
                          checked={readOnly}
                          onChange={(event) => setReadOnly(event.target.checked)}
                        />
                        {readOnly ? "Managed read-only" : "Managed writes enabled"}
                      </label>
                    </div>
                    <div>
                      {active ? (
                        <button
                          type="button"
                          className="cancel-button"
                          onClick={() =>
                            void action(async () => {
                              await api("cancel", { id: active.id });
                              await refresh();
                            })
                          }
                        >
                          ■ Cancel
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="primary-button"
                          disabled={
                            !file || !state.target || busy || analysis?.diagnostics.some((d) => d.severity === "error")
                          }
                          onClick={() => void action(run)}
                        >
                          ▶ Run query <kbd>⌘↵</kbd>
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
            <aside className="inspector">
              <div className="inspector-tabs">
                <button
                  type="button"
                  className={inspector === "types" ? "active" : ""}
                  onClick={() => setInspector("types")}
                >
                  Types
                </button>
                <button
                  type="button"
                  className={inspector === "parameters" ? "active" : ""}
                  onClick={() => setInspector("parameters")}
                >
                  Parameters
                </button>
                <button
                  type="button"
                  className={inspector === "schema" ? "active" : ""}
                  onClick={() => setInspector("schema")}
                >
                  Inspector
                </button>
              </div>
              {inspector === "schema" ? (
                selectedTable ? (
                  <div className="inspector-content">
                    <span className="eyebrow">{selectedTable.kind.toUpperCase()}</span>
                    <h2>{selectedTable.name}</h2>
                    <p className="muted">
                      {selectedTable.namespace || "default"} · {selectedTable.columns.length} columns
                    </p>
                    <button
                      type="button"
                      className="primary-button wide"
                      onClick={() =>
                        setCreate({
                          table: selectedTable,
                          path: `${state.scratchDirectory}/${selectedTable.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.ts`,
                        })
                      }
                    >
                      ⌁ Create query from table
                    </button>
                    <div className="detail-section">
                      <h3>Columns</h3>
                      {selectedTable.columns.map((column) => (
                        <div className="inspector-column" key={column.name}>
                          <div>
                            <strong>
                              {column.primary ? "◆ " : ""}
                              {column.name}
                            </strong>
                            <span>{column.nullable ? "nullable" : "required"}</span>
                          </div>
                          <code>{column.databaseType}</code>
                          <small>
                            {column.tsType}
                            {column.nullable ? " | null" : ""}
                          </small>
                        </div>
                      ))}
                    </div>
                    <div className="detail-section">
                      <h3>Catalog evidence</h3>
                      <p>
                        {selectedTable.constraints.length} constraints · {selectedTable.indexes.length} indexes
                      </p>
                      <pre>
                        {JSON.stringify(
                          { constraints: selectedTable.constraints, indexes: selectedTable.indexes },
                          null,
                          2,
                        )}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <div className="inspector-empty">
                    <span>↖</span>
                    <p>Select a relation to inspect its columns and captured constraints.</p>
                  </div>
                )
              ) : inspector === "parameters" ? (
                <div className="inspector-content">
                  <span className="eyebrow">BOUND VALUES</span>
                  <h3>Query parameters</h3>
                  {!analysis?.queries[0]?.parameterCount ? (
                    <p className="muted">
                      {file.endsWith(".sql")
                        ? "This statement has no parameters."
                        : "Inline TS values come from your file. Use the types tab to inspect the ordered tuple."}
                    </p>
                  ) : (
                    Array.from({ length: analysis.queries[0].parameterCount }, (_, offset) => {
                      const index = offset + 1;
                      const param = analysis.queries[0]?.parameters?.find((p) => p.index === index);
                      return (
                        <label className="parameter-input" key={index}>
                          <span>
                            {param?.name ?? `$${index}`} <code>{param?.tsType ?? "unknown"}</code>
                          </span>
                          <input
                            aria-label={`Parameter ${index}`}
                            disabled={parameters[index]?.null}
                            value={parameters[index]?.value ?? ""}
                            placeholder="Enter bound value"
                            onChange={(event) =>
                              setParameters((current) => ({
                                ...current,
                                [index]: { value: event.target.value, null: current[index]?.null ?? false },
                              }))
                            }
                          />
                          <span className="null-toggle">
                            <input
                              type="checkbox"
                              checked={parameters[index]?.null ?? false}
                              onChange={(event) =>
                                setParameters((current) => ({
                                  ...current,
                                  [index]: { value: current[index]?.value ?? "", null: event.target.checked },
                                }))
                              }
                            />
                            NULL
                          </span>
                        </label>
                      );
                    })
                  )}
                  <p className="small-note">Values are bound separately. Parameter values are not saved by default.</p>
                </div>
              ) : (
                <div className="inspector-content">
                  <span className="eyebrow">STATIC ANALYSIS</span>
                  <div className="analysis-status">
                    <span
                      className={`connection-dot ${analysis && !analysis.diagnostics.some((d) => d.severity === "error") ? "online" : ""}`}
                    />
                    {analysis
                      ? analysis.diagnostics.some((d) => d.severity === "error")
                        ? "Needs attention"
                        : "SQL analysis current"
                      : "Open a query file"}
                  </div>
                  {analysis?.queries.map((query, index) => (
                    <section
                      className="contract-card"
                      key={`${analysis.revision}:${query.rowType}:${query.parameterType}`}
                    >
                      <h3>
                        Query {index + 1} <span>inferred</span>
                      </h3>
                      <small>ROW TYPE</small>
                      <pre>{query.rowType.replaceAll("; ", ";\n  ")}</pre>
                      <small>PARAMETER TUPLE</small>
                      <pre>{query.parameterType}</pre>
                      {query.sql ? (
                        <>
                          <small>PARAMETERIZED SQL</small>
                          <pre>{query.sql}</pre>
                        </>
                      ) : null}
                    </section>
                  ))}
                  {analysis?.diagnostics.map((diagnostic) => (
                    <div
                      className={`diagnostic ${diagnostic.severity}`}
                      key={`${diagnostic.code}:${diagnostic.range.line}:${diagnostic.range.column}:${diagnostic.message}`}
                    >
                      <strong>
                        {diagnostic.code} · {diagnostic.range.line}:{diagnostic.range.column}
                      </strong>
                      <p>{diagnostic.message}</p>
                    </div>
                  ))}
                  <p className="small-note">
                    SQL analysis runs while you edit. Full TypeScript and dependency checks run before execution. A
                    successful database run never strengthens an unknown static contract.
                  </p>
                </div>
              )}
            </aside>
          </div>
          {view === "editor" ? (
            <ResultPanel
              key={state.runs[0]?.id ?? "empty"}
              run={state.runs[0]}
              file={file}
              revision={revision}
              dirty={dirty}
            />
          ) : (
            <div className="schema-footer">
              <span>
                <span className="legend-key">◆</span> Primary key <span className="legend-key">◇</span> Unique{" "}
                <span className="legend-line" /> Captured foreign key
              </span>
              <span>Drag to arrange · Scroll to zoom · Layout stays local</span>
            </div>
          )}
        </main>
      </div>
      <footer className="statusbar">
        <span>
          <span className="connection-dot online" /> {state.grammar} · schema {state.schemaHash.slice(0, 10)}
        </span>
        <span>
          {state.trusted ? "Trusted project execution enabled" : "Project execution disabled"} ·{" "}
          {state.target ? "Managed target configured" : "Offline analysis"} · {state.limits.maxRows} row limit
        </span>
      </footer>
      {showTrust ? (
        <Modal className="create-dialog" label="Enable trusted project execution" onClose={() => setShowTrust(false)}>
          <span className="eyebrow">LOCAL PROJECT EXECUTION</span>
          <h2 id="trust-title">Run code you trust.</h2>
          <p>
            TypeScript files and their imports run with your local process permissions. They can read files, access
            environment variables, use the network, or open their own database connections.
          </p>
          <p>
            Managed read-only and cancellation apply to the supplied database helper. They cannot restrict private
            clients or undo external effects.
          </p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setShowTrust(false)}>
              Keep disabled
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() =>
                void action(async () => {
                  await api("trust", { enable: true });
                  await refresh();
                  setShowTrust(false);
                  setNotice("Project execution enabled for this session. Press Run to execute.");
                })
              }
            >
              Enable for this session
            </button>
          </div>
        </Modal>
      ) : null}
      {create ? (
        <Modal className="create-dialog" label="Create a query file" onClose={() => setCreate(null)}>
          <span className="eyebrow">PROJECT FILE</span>
          <h2 id="create-title">{create.table ? `Query ${create.table.name}` : "Create a query file"}</h2>
          <p>
            {create.table
              ? "Generate explicit qualified SQL and a managed database helper in your project."
              : "Use .ts for project code or .sql for a bound SQL statement."}
          </p>
          <label className="form-label">
            Project-relative path
            <input value={create.path} onChange={(event) => setCreate({ ...create, path: event.target.value })} />
          </label>
          <pre className="template-preview">
            {create.table
              ? `select ${create.table.columns
                  .slice(0, 4)
                  .map((c) => c.name)
                  .join(", ")}\nfrom ${create.table.namespace ? `${create.table.namespace}.` : ""}${create.table.name}`
              : create.path.endsWith(".sql")
                ? "-- Write a parameterized SQL statement here."
                : "export async function run() {\n  return [];\n}"}
          </pre>
          <div className="dialog-actions">
            <button type="button" onClick={() => setCreate(null)}>
              Cancel
            </button>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void action(newFile)}>
              Create file
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
