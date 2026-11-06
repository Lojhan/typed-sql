import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentPanel } from "./agent";
import { api, token } from "./api";
import { SchemaBoard } from "./board";
import { ComparePanel } from "./compare";
import { Editor } from "./editor";
import {
  changePane,
  close,
  drop,
  type Edge,
  FILE_MIME,
  fileTree,
  isTool,
  type Layout,
  open,
  type Pane,
  pane,
  panes,
  ratio,
  type TreeNode,
  title,
  validLayout,
} from "./layout";
import { Modal } from "./modal";
import { PaneLayout, Resize } from "./panes";
import { ResultPanel } from "./results";
import type { Analysis, State, Value } from "./types";
import "./style.css";

interface Document {
  file: string;
  source: string;
  saved: string;
  revision: string;
  writable: boolean;
  analysis?: Analysis;
  mode: "sql" | "file" | "export";
  exportName: string;
  readOnly: boolean;
  parameters: Record<number, { value: string; null: boolean }>;
}
function Tree({
  nodes,
  selected,
  onOpen,
  query,
}: {
  nodes: TreeNode[];
  selected: string;
  onOpen: (file: string) => void;
  query: string;
}) {
  return (
    <ul className="file-tree">
      {nodes.map((node) => (
        <li key={node.path}>
          {node.file ? (
            <button
              type="button"
              className={selected === node.path ? "selected" : ""}
              title={node.path}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(FILE_MIME, JSON.stringify({ tab: node.path }));
                event.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => onOpen(node.path)}
            >
              <span className={`file-badge ${node.path.endsWith(".sql") ? "sql" : "ts"}`}>
                {node.path.endsWith(".sql") ? "SQL" : "TS"}
              </span>
              <span>{node.name}</span>
            </button>
          ) : (
            <details open={query ? true : undefined}>
              <summary>
                <span className="folder-glyph">▱</span>
                {node.name}
              </summary>
              <Tree nodes={node.children} selected={selected} onOpen={onOpen} query={query} />
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}
function App() {
  const [state, setState] = useState<State | null>(null),
    [documents, setDocuments] = useState<Record<string, Document>>({}),
    [layout, setLayout] = useState<Layout>(() => pane("@schema")),
    [activePane, setActivePane] = useState(""),
    [sidebar, setSidebar] = useState(238),
    [sidebarVisible, setSidebarVisible] = useState(true),
    [search, setSearch] = useState(""),
    [schemaSearch, setSchemaSearch] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [trust, setTrust] = useState(false),
    [create, setCreate] = useState<{ path: string; table: string } | null>(null),
    [closing, setClosing] = useState<{ paneId: string; tab: string } | null>(null),
    [selectedTable, setSelectedTable] = useState<string | null>(null),
    [lastFile, setLastFile] = useState(""),
    [compareA, setCompareA] = useState<string | undefined>();
  const stateRef = useRef<State | null>(null),
    documentsRef = useRef(documents),
    layoutRef = useRef(layout),
    initialized = useRef(false),
    etag = useRef(""),
    loading = useRef(new Map<string, Promise<void>>()),
    analysisSources = useRef(new Map<string, string>()),
    analysisTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>()),
    storageKey = useRef("");
  documentsRef.current = documents;
  layoutRef.current = layout;
  const dirty = useMemo(
    () =>
      new Set(
        Object.values(documents)
          .filter((doc) => doc.source !== doc.saved)
          .map((doc) => doc.file),
      ),
    [documents],
  );
  const focused = panes(layout).find((item) => item.id === activePane) ?? panes(layout)[0]!;
  const focusedFile = !isTool(focused.active) ? focused.active : lastFile;
  const selectedDoc = documents[focusedFile];
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
    if (!response.ok) throw new Error("Workspace disconnected. Reopen the local session URL.");
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
  const action = useCallback(async (task: () => Promise<void>) => {
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
  }, []);
  const load = useCallback(async (file: string, reload = false) => {
    if (isTool(file) || (!reload && documentsRef.current[file])) return;
    if (loading.current.has(file)) return loading.current.get(file);
    const pending = (async () => {
      const next = await api<{ file: string; source: string; revision: string; writable: boolean }>("file", { file });
      setDocuments((current) => ({
        ...current,
        [file]: {
          file,
          source: next.source,
          saved: next.source,
          revision: next.revision,
          writable: next.writable,
          mode: file.endsWith(".sql") ? "sql" : "export",
          exportName: "run",
          readOnly: true,
          parameters: {},
        },
      }));
    })();
    loading.current.set(file, pending);
    try {
      await pending;
    } finally {
      loading.current.delete(file);
    }
  }, []);
  useEffect(() => {
    void refresh().catch((error) => setError(error.message));
    const interval = setInterval(() => void refresh().catch((error) => setError(error.message)), 900);
    return () => clearInterval(interval);
  }, [refresh]);
  useEffect(() => {
    if (!state || initialized.current) return;
    initialized.current = true;
    storageKey.current = `typed-sql-workspace-v2:${state.project.name}:${state.project.config}:${state.target ?? "offline"}`;
    let initial = layoutRef.current;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey.current) ?? "null") as {
        layout?: unknown;
        sidebar?: unknown;
        active?: unknown;
      } | null;
      const parsed = validLayout(saved?.layout, new Set(state.files));
      if (parsed) initial = parsed;
      if (typeof saved?.sidebar === "number" && Number.isFinite(saved.sidebar))
        setSidebar(Math.max(150, Math.min(440, saved.sidebar)));
      if (typeof saved?.active === "string" && panes(initial).some((item) => item.id === saved.active))
        setActivePane(saved.active);
      else setActivePane(panes(initial)[0]!.id);
    } catch {
      setActivePane(panes(initial)[0]!.id);
    }
    setLayout(initial);
    for (const file of new Set(
      panes(initial)
        .flatMap((item) => item.tabs)
        .filter((tab) => !isTool(tab)),
    ))
      void load(file).catch((error) => setError(error.message));
  }, [state, load]);
  useEffect(() => {
    if (!initialized.current || !storageKey.current) return;
    try {
      localStorage.setItem(storageKey.current, JSON.stringify({ layout, sidebar, active: activePane }));
    } catch {}
  }, [layout, sidebar, activePane]);
  useEffect(() => {
    const stop = (event: BeforeUnloadEvent) => {
      if (dirty.size) event.preventDefault();
    };
    window.addEventListener("beforeunload", stop);
    return () => window.removeEventListener("beforeunload", stop);
  }, [dirty]);
  useEffect(() => {
    for (const doc of Object.values(documents)) {
      if (analysisSources.current.get(doc.file) === doc.source) continue;
      analysisSources.current.set(doc.file, doc.source);
      const previous = analysisTimers.current.get(doc.file);
      if (previous) clearTimeout(previous);
      const source = doc.source;
      analysisTimers.current.set(
        doc.file,
        setTimeout(() => {
          analysisTimers.current.delete(doc.file);
          void api<Analysis>("analyze", { file: doc.file, source }).then(
            (analysis) =>
              setDocuments((current) =>
                current[doc.file]?.source === source
                  ? { ...current, [doc.file]: { ...current[doc.file]!, analysis } }
                  : current,
              ),
            (error) =>
              setDocuments((current) =>
                current[doc.file]?.source === source
                  ? {
                      ...current,
                      [doc.file]: {
                        ...current[doc.file]!,
                        analysis: {
                          revision: "",
                          queries: [],
                          exports: [],
                          diagnostics: [
                            {
                              code: "ANALYSIS",
                              severity: "error",
                              message: error.message,
                              range: { line: 1, column: 1 },
                            },
                          ],
                        },
                      },
                    }
                  : current,
              ),
          );
        }, 300),
      );
    }
  }, [documents]);
  useEffect(
    () => () => {
      for (const timer of analysisTimers.current.values()) clearTimeout(timer);
    },
    [],
  );
  const edit = (file: string, patch: Partial<Document>) =>
    setDocuments((current) => (current[file] ? { ...current, [file]: { ...current[file]!, ...patch } } : current));
  const openTab = useCallback(
    (paneId: string, tab: string) => {
      setLayout((current) => open(current, paneId, tab));
      setActivePane(paneId);
      if (!isTool(tab)) {
        setLastFile(tab);
        void load(tab).catch((error) => setError(error.message));
      }
    },
    [load],
  );
  const save = async (file: string) => {
    const doc = documentsRef.current[file];
    if (!doc) return null;
    if (doc.source === doc.saved) return doc.revision;
    if (!doc.writable) throw new Error("File is outside writeRoots. Save a copy in the scratch folder.");
    const source = doc.source;
    const saved = await api<{ revision: string }>("save", { file, source, revision: doc.revision });
    setDocuments((current) =>
      current[file] ? { ...current, [file]: { ...current[file]!, saved: source, revision: saved.revision } } : current,
    );
    return saved.revision;
  };
  const run = async (file: string) => {
    const doc = documentsRef.current[file];
    if (!doc || !state?.target) return;
    if (doc.mode !== "sql" && !state.trusted) {
      setTrust(true);
      return;
    }
    if (state.executionSchemaStale)
      throw new Error("Live schema differs from the compiler snapshot. Generate and restart before running.");
    const revision = await save(file);
    if (!revision) return;
    const analysis = await api<Analysis>("analyze", { file, source: doc.source });
    edit(file, { analysis });
    if (analysis.diagnostics.some((item) => item.severity === "error"))
      throw new Error("Fix query diagnostics before running.");
    const values: Value[] = [];
    if (doc.mode === "sql")
      for (let index = 1; index <= (analysis.queries[0]?.parameterCount ?? 0); index++) {
        const input = doc.parameters[index],
          parameter = analysis.queries[0]?.parameters?.find((item) => item.index === index);
        if (input?.null) {
          if (!parameter?.nullable) throw new Error(`Parameter ${index} does not accept NULL`);
          values.push(null);
          continue;
        }
        if (!input) throw new Error(`Enter parameter ${parameter?.name ?? index}`);
        if (parameter?.tsType === "number") {
          const value = Number(input.value);
          if (!Number.isFinite(value) || !input.value.trim())
            throw new Error(`Parameter ${index} requires a finite number`);
          values.push(value);
        } else if (parameter?.tsType === "bigint") {
          if (!/^-?\d+$/.test(input.value)) throw new Error(`Parameter ${index} requires an integer`);
          values.push({ kind: "bigint", value: input.value });
        } else if (parameter?.tsType === "boolean") {
          if (!["true", "false"].includes(input.value)) throw new Error(`Parameter ${index} requires true or false`);
          values.push(input.value === "true");
        } else if (parameter?.tsType === "Date") {
          const value = new Date(input.value);
          if (!Number.isFinite(value.getTime())) throw new Error(`Parameter ${index} requires a date`);
          values.push({ kind: "date", value: value.toISOString() });
        } else values.push(input.value);
      }
    await api("run", {
      requestId: crypto.randomUUID(),
      file,
      revision,
      mode: doc.mode,
      exportName: doc.exportName,
      readOnly: doc.readOnly,
      values,
    });
    await refresh();
  };
  const activate = (id: string) => {
    setActivePane(id);
    const current = panes(layoutRef.current).find((item) => item.id === id);
    if (current?.active && !isTool(current.active)) setLastFile(current.active);
  };
  const split = (id: string, edge: Edge) => {
    const target = panes(layoutRef.current).find((item) => item.id === id);
    if (!target) return;
    const next = drop(layoutRef.current, id, target.active, edge);
    setLayout(next.layout);
    setActivePane(next.active);
  };
  const dropTab = (id: string, tab: string, edge: Edge, source?: string) => {
    const next = drop(layoutRef.current, id, tab, edge, source);
    setLayout(next.layout);
    setActivePane(next.active);
    if (!isTool(tab)) void load(tab).catch((error) => setError(error.message));
  };
  const closeTab = (paneId: string, tab: string, discard = false, bypass = false) => {
    const other = panes(layoutRef.current).filter((item) => item.id !== paneId && item.tabs.includes(tab)).length;
    if (!discard && !bypass && dirty.has(tab) && !other) {
      setClosing({ paneId, tab });
      return;
    }
    setLayout((current) => {
      const next = close(current, paneId, tab);
      setActivePane(panes(next).find((item) => item.id === paneId)?.id ?? panes(next)[0]!.id);
      return next;
    });
    if (discard) edit(tab, { source: documentsRef.current[tab]?.saved ?? "" });
  };
  const changeFile = async (file: string) => {
    if (dirty.has(file)) {
      setError(`${file} changed outside this editor. Unsaved buffer preserved; save a copy or reload explicitly.`);
      return;
    }
    await load(file, true);
    await refresh();
  };
  const compare = (id: string) => {
    setCompareA(id);
    openTab(focused.id, "@compare");
  };
  const fileAction = async (file: string, kind: "copy" | "rename" | "reload" | "types") => {
    const doc = documentsRef.current[file];
    if (!doc) return;
    if (kind === "reload") {
      if (dirty.has(file) && !confirm("Discard unsaved edits and reload from disk?")) return;
      await load(file, true);
      return;
    }
    const revision = await save(file);
    if (!revision) return;
    if (kind === "types") {
      const output = await api<{ file: string }>("sql-types", { file, revision });
      setNotice(`Generated ${output.file}`);
      await refresh();
      return;
    }
    const path = prompt(kind === "copy" ? "Save copy as" : "Rename file", file);
    if (!path || path === file) return;
    if (kind === "copy") await api("save", { file: path, source: doc.source, revision: null });
    else {
      await api("move", { file, to: path, revision });
      setDocuments((current) => {
        const next = { ...current };
        delete next[file];
        next[path] = { ...doc, file: path, saved: doc.source };
        return next;
      });
      setLayout((current) => {
        let next = current;
        for (const item of panes(current))
          next = changePane(next, item.id, (value) => ({
            ...value,
            tabs: value.tabs.map((tab) => (tab === file ? path : tab)),
            active: value.active === file ? path : value.active,
          }));
        return next;
      });
    }
    await refresh();
    openTab(focused.id, path);
  };
  const newFile = async () => {
    if (!create || !state) return;
    if (create.table) await api("create-query", { table: create.table, file: create.path });
    else
      await api("save", {
        file: create.path,
        source: create.path.endsWith(".sql") ? "select 1;\n" : "export async function run() {\n  return [];\n}\n",
        revision: null,
      });
    const path = create.path;
    setCreate(null);
    await refresh();
    openTab(focused.id, path);
  };
  const bottom = (item: Pane, doc: Document) => {
    if (item.bottom === "results") {
      const run = state!.runs.find((run) => run.id === item.runId) ?? state!.runs.find((run) => run.file === doc.file);
      return (
        <ResultPanel
          run={run}
          file={doc.file}
          revision={doc.revision}
          dirty={doc.source !== doc.saved}
          schemaHash={state!.schemaHash}
          typePolicyHash={state!.typePolicyHash}
          onCompare={compare}
        />
      );
    }
    if (item.bottom === "types")
      return (
        <div className="contract-view">
          {doc.analysis?.queries.map((query, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: query ordinal is compiler source order.
            <section key={`${query.rowType}:${index}`}>
              <header>Query {index + 1}</header>
              <div>
                <small>Row</small>
                <pre>{query.rowType.replaceAll("; ", ";\n  ")}</pre>
              </div>
              <div>
                <small>Parameters</small>
                <pre>{query.parameterType}</pre>
              </div>
              {query.sql ? (
                <div>
                  <small>SQL</small>
                  <pre>{query.sql}</pre>
                </div>
              ) : null}
            </section>
          ))}
          {!doc.analysis?.queries.length ? <div className="quiet-empty">No inferred SQL query.</div> : null}
        </div>
      );
    if (item.bottom === "problems")
      return (
        <div className="problems-list">
          {doc.analysis?.diagnostics.length ? (
            doc.analysis.diagnostics.map((problem) => (
              <div
                className={problem.severity}
                key={`${problem.code}:${problem.range.line}:${problem.range.column}:${problem.message}`}
              >
                <code>{problem.code}</code>
                <span>{problem.message}</span>
                <small>
                  {problem.range.line}:{problem.range.column}
                </small>
              </div>
            ))
          ) : (
            <div className="quiet-empty">No SQL diagnostics. TypeScript is checked on Run.</div>
          )}
        </div>
      );
    return (
      <div className="bindings-view">
        {Array.from({ length: doc.analysis?.queries[0]?.parameterCount ?? 0 }, (_, offset) => {
          const index = offset + 1,
            param = doc.analysis?.queries[0]?.parameters?.find((value) => value.index === index);
          return (
            <div className="binding-row" key={`binding-${index}`}>
              <label htmlFor={`${item.id}-param-${index}`}>
                {param?.name ?? `$${index}`}
                <code>{param?.tsType ?? "unknown"}</code>
              </label>
              <input
                id={`${item.id}-param-${index}`}
                disabled={doc.parameters[index]?.null}
                value={doc.parameters[index]?.value ?? ""}
                placeholder="Bound value"
                onChange={(event) =>
                  edit(doc.file, {
                    parameters: {
                      ...doc.parameters,
                      [index]: { value: event.target.value, null: doc.parameters[index]?.null ?? false },
                    },
                  })
                }
              />
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={doc.parameters[index]?.null ?? false}
                  onChange={(event) =>
                    edit(doc.file, {
                      parameters: {
                        ...doc.parameters,
                        [index]: { value: doc.parameters[index]?.value ?? "", null: event.target.checked },
                      },
                    })
                  }
                />
                NULL
              </label>
            </div>
          );
        })}
        {!doc.analysis?.queries[0]?.parameterCount ? (
          <div className="quiet-empty">
            {doc.file.endsWith(".sql") ? "No bound parameters." : "Parameters come from the TypeScript file."}
          </div>
        ) : null}
      </div>
    );
  };
  const renderPane = (item: Pane) => {
    if (!state) return null;
    if (item.active === "@schema")
      return (
        <div className="schema-tab">
          <div className="tool-toolbar">
            <input
              aria-label="Search schema"
              placeholder="Find relation or column"
              value={schemaSearch}
              onChange={(event) => setSchemaSearch(event.target.value)}
            />
            <span>
              {state.board.tables.length} relations · {state.board.edges.length} foreign keys
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await api("refresh", {});
                  await refresh();
                })
              }
            >
              Refresh
            </button>
          </div>
          <SchemaBoard
            board={state.board}
            selected={selectedTable}
            onSelect={setSelectedTable}
            search={schemaSearch}
            identity={`${state.project.name}:${state.target ?? "offline"}`}
          />
          {selectedTable ? (
            <div className="schema-selection">
              {state.board.tables.find((table) => table.id === selectedTable)?.name}
              <span>
                {state.board.tables
                  .find((table) => table.id === selectedTable)
                  ?.columns.map((column) => `${column.name}: ${column.databaseType}`)
                  .join(" · ")}
              </span>
            </div>
          ) : null}
        </div>
      );
    if (item.active === "@compare")
      return <ComparePanel runs={state.runs} {...(compareA ? { initialA: compareA } : {})} />;
    if (item.active === "@agent")
      return (
        <AgentPanel
          state={state}
          {...(selectedDoc
            ? {
                source: {
                  file: selectedDoc.file,
                  source: selectedDoc.source,
                  revision: selectedDoc.source === selectedDoc.saved ? selectedDoc.revision : null,
                },
              }
            : {})}
          onOpen={(file) => openTab(item.id, file)}
          onChanged={(file) => void action(() => changeFile(file))}
          onTrust={() => setTrust(true)}
        />
      );
    const doc = documents[item.active];
    if (!doc)
      return <div className="quiet-empty">{item.active ? "Opening file…" : "Open a file from the project tree."}</div>;
    const active = state.runs.find((run) => ["checking", "running", "cancelling"].includes(run.status));
    return (
      <div className="document-workspace">
        <div className="document-toolbar">
          <span className="document-path" title={doc.file}>
            {doc.file}
          </span>
          <select
            aria-label={`Execution mode for ${doc.file}`}
            value={doc.mode}
            disabled={doc.file.endsWith(".sql")}
            onChange={(event) => edit(doc.file, { mode: event.target.value as Document["mode"] })}
          >
            <option value="export">Export</option>
            <option value="file">File</option>
            <option value="sql">SQL</option>
          </select>
          {doc.mode === "export" ? (
            <select
              aria-label="Callable export"
              value={doc.exportName}
              onChange={(event) => edit(doc.file, { exportName: event.target.value })}
            >
              {(doc.analysis?.exports.length ? doc.analysis.exports : ["run"]).map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          ) : null}
          <label className="checkbox-label read-only">
            <input
              type="checkbox"
              checked={doc.readOnly}
              onChange={(event) => edit(doc.file, { readOnly: event.target.checked })}
            />
            Read only
          </label>
          <button
            type="button"
            disabled={busy || !dirty.has(doc.file)}
            onClick={() =>
              void action(async () => {
                await save(doc.file);
              })
            }
            title="Save (⌘S)"
          >
            Save
          </button>
          <details className="file-menu">
            <summary aria-label="File actions">⋯</summary>
            <div>
              {(["copy", "rename", "reload", ...(doc.file.endsWith(".sql") ? ["types"] : [])] as const).map((kind) => (
                <button
                  type="button"
                  key={kind}
                  onClick={() =>
                    void action(() => fileAction(doc.file, kind as "copy" | "rename" | "reload" | "types"))
                  }
                >
                  {kind === "copy"
                    ? "Save copy as…"
                    : kind === "rename"
                      ? "Rename…"
                      : kind === "reload"
                        ? "Reload from disk"
                        : "Generate TS types"}
                </button>
              ))}
            </div>
          </details>
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
              ■ Stop
            </button>
          ) : (
            <button
              type="button"
              className="run-button"
              disabled={!state.target || busy}
              onClick={() => void action(() => run(doc.file))}
              title="Run (⌘Enter)"
            >
              ▷ Run
            </button>
          )}
        </div>
        <div className="document-editor" style={{ flex: `${1 - item.bottomRatio} 1 0` }}>
          <Editor
            session={`${state.project.name}:${item.id}:${doc.file}`}
            file={doc.file}
            source={doc.source}
            onChange={(source) => edit(doc.file, { source })}
            onSave={() =>
              void action(async () => {
                await save(doc.file);
              })
            }
            onRun={() => void action(() => run(doc.file))}
          />
        </div>
        <Resize
          axis="vertical"
          label="Resize editor and results"
          onChange={(delta, size) =>
            setLayout((current) =>
              changePane(current, item.id, (value) => ({
                ...value,
                bottomRatio: Math.max(0.15, Math.min(0.8, value.bottomRatio - delta / size)),
              })),
            )
          }
        />
        <div className="document-bottom" style={{ flex: `${item.bottomRatio} 1 0` }}>
          <div className="bottom-tabs" role="tablist" aria-label="Query tools">
            {(["results", "types", "bindings", "problems"] as const).map((tab) => (
              <button
                type="button"
                role="tab"
                aria-selected={item.bottom === tab}
                className={item.bottom === tab ? "selected" : ""}
                key={tab}
                onClick={() =>
                  setLayout((current) => changePane(current, item.id, (value) => ({ ...value, bottom: tab })))
                }
              >
                {tab[0]!.toUpperCase() + tab.slice(1)}
                {tab === "problems" && doc.analysis?.diagnostics.length ? (
                  <span>{doc.analysis.diagnostics.length}</span>
                ) : null}
              </button>
            ))}
            {item.bottom === "results" ? (
              <select
                aria-label="Captured execution"
                value={item.runId ?? ""}
                onChange={(event) =>
                  setLayout((current) =>
                    changePane(current, item.id, (value) => ({
                      ...value,
                      runId: event.target.value,
                    })),
                  )
                }
              >
                <option value="">Latest for this file</option>
                {state.runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.file.split("/").at(-1)} · {new Date(run.startedAt).toLocaleTimeString()}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          {bottom(item, doc)}
        </div>
      </div>
    );
  };
  if (!state)
    return (
      <main className="boot">
        <strong>typed-sql</strong>
        <span>{error || "Opening workspace…"}</span>
      </main>
    );
  const inventory = state.files.filter(
    (file) => !/\.d\.[cm]?ts$/u.test(file) && file.toLowerCase().includes(search.toLowerCase()),
  );
  const tree = fileTree(inventory);
  const problems = Object.values(documents).reduce((sum, doc) => sum + (doc.analysis?.diagnostics.length ?? 0), 0);
  return (
    <div className="app-shell">
      <header className="workspace-toolbar">
        <button
          type="button"
          className="project-toggle"
          onClick={() => setSidebarVisible((value) => !value)}
          title="Toggle project tree"
        >
          ◫
        </button>
        <strong>{state.project.name}</strong>
        <span className="toolbar-divider" />
        <button
          type="button"
          className={focused.active === "@schema" ? "selected" : ""}
          onClick={() => openTab(focused.id, "@schema")}
        >
          ⌘ Schema
        </button>
        <button
          type="button"
          className={focused.active === "@compare" ? "selected" : ""}
          onClick={() => openTab(focused.id, "@compare")}
        >
          ⇄ Compare
        </button>
        <button
          type="button"
          className={focused.active === "@agent" ? "selected" : ""}
          onClick={() => openTab(focused.id, "@agent")}
        >
          ✦ Agent
        </button>
        <div className="connection-controls">
          <span className={`status-dot ${state.connection.state === "connected" ? "succeeded" : ""}`} />
          <span>{state.connection.identity?.database ?? state.target ?? "Offline"}</span>
          <span className="muted">{state.grammar}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await api(state.connection.state === "connected" ? "refresh" : "connect", {});
                await refresh();
              })
            }
          >
            {state.connection.state === "connected" ? "↻" : "Connect"}
          </button>
        </div>
      </header>
      {error ? (
        <div className="workspace-banner error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError("")}>
            ×
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="workspace-banner" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      ) : null}
      {state.executionSchemaStale ? (
        <div className="workspace-banner warning">
          Live schema changed. Generate the compiler snapshot and restart before running.
        </div>
      ) : null}
      <div className="workspace-body">
        {sidebarVisible ? (
          <>
            <aside className="project-sidebar" style={{ width: sidebar }}>
              <div className="tree-heading">
                <span>PROJECT</span>
                <button
                  type="button"
                  onClick={() => setCreate({ path: `${state.scratchDirectory}/query.ts`, table: selectedTable ?? "" })}
                >
                  New…
                </button>
              </div>
              <input
                className="tree-search"
                aria-label="Filter project files"
                placeholder="Filter files"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <div className="project-root">▱ {state.project.name}</div>
              <nav aria-label="Project files">
                <Tree nodes={tree} selected={focusedFile} query={search} onOpen={(file) => openTab(focused.id, file)} />
              </nav>
              <div className="tree-footer">{state.scratchDirectory}/ · on disk</div>
            </aside>
            <Resize
              axis="horizontal"
              label="Resize project tree"
              onChange={(delta) => setSidebar((value) => Math.max(150, Math.min(440, value + delta)))}
            />
          </>
        ) : null}
        <main className="editor-area">
          <PaneLayout
            node={layout}
            active={focused.id}
            dirty={dirty}
            onActivate={activate}
            onOpen={openTab}
            onClose={closeTab}
            onSplit={split}
            onDrop={dropTab}
            onRatio={(id, delta, size) =>
              setLayout((current) => {
                const find = (node: Layout): number | undefined =>
                  node.kind === "split"
                    ? node.id === id
                      ? node.ratio
                      : (find(node.first) ?? find(node.second))
                    : undefined;
                return ratio(current, id, (find(current) ?? 0.5) + delta / size);
              })
            }
            render={renderPane}
          />
        </main>
      </div>
      <footer className="workspace-status">
        <span>
          {problems ? `${problems} SQL diagnostics` : "✓ SQL analysis"}
          {dirty.size ? ` · ${dirty.size} unsaved` : ""}
        </span>
        <span>
          {state.connection.state} · {state.schemaSource} schema ·{" "}
          {state.trusted ? "trusted project execution" : "project execution disabled"}
        </span>
      </footer>
      {create ? (
        <Modal className="create-dialog" label="Create project file" onClose={() => setCreate(null)}>
          <h3>New file</h3>
          <label>
            Path
            <input value={create.path} onChange={(event) => setCreate({ ...create, path: event.target.value })} />
          </label>
          <label>
            Template
            <select value={create.table} onChange={(event) => setCreate({ ...create, table: event.target.value })}>
              <option value="">Blank file</option>
              {state.board.tables.map((table) => (
                <option key={table.id} value={table.id}>
                  Query {table.namespace ? `${table.namespace}.` : ""}
                  {table.name}
                </option>
              ))}
            </select>
          </label>
          <div className="dialog-actions">
            <button type="button" onClick={() => setCreate(null)}>
              Cancel
            </button>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void action(newFile)}>
              Create
            </button>
          </div>
        </Modal>
      ) : null}
      {trust ? (
        <Modal className="create-dialog" label="Enable project execution" onClose={() => setTrust(false)}>
          <h3>Enable trusted project execution?</h3>
          <p>
            Project files and local agents can access your files, environment, network and private database clients.
            Managed read-only controls do not restrict those private clients.
          </p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setTrust(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() =>
                void action(async () => {
                  await api("trust", { enable: true });
                  await refresh();
                  setTrust(false);
                })
              }
            >
              Enable for this session
            </button>
          </div>
        </Modal>
      ) : null}
      {closing ? (
        <Modal className="create-dialog" label="Unsaved changes" onClose={() => setClosing(null)}>
          <h3>Save {title(closing.tab)}?</h3>
          <p>This is the last open view of the unsaved file.</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setClosing(null)}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                closeTab(closing.paneId, closing.tab, true);
                setClosing(null);
              }}
            >
              Discard
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() =>
                void action(async () => {
                  await save(closing.tab);
                  closeTab(closing.paneId, closing.tab, false, true);
                  setClosing(null);
                })
              }
            >
              Save and close
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
