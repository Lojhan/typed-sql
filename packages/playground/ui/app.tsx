import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentPanel } from "./agent";
import { api, token } from "./api";
import { SchemaBoard } from "./board";
import { CommandPalette, type PaletteCommand } from "./command-palette.js";
import { ComparePanel } from "./compare";
import { Editor, editorLanguageCommand, findInEditor } from "./editor";
import {
  type LanguageDiagnostic,
  type LanguageLocation,
  type LanguageRange,
  mergeDocumentDiagnostics,
  offsetAt,
} from "./editor-language-model.js";
import { WorkspaceFileTree } from "./file-tree";
import { Icon } from "./icon";
import {
  changePane,
  close,
  drop,
  type Edge,
  isTool,
  type Layout,
  open,
  type Pane,
  pane,
  panes,
  ratio,
  title,
  validLayout,
} from "./layout";
import { Modal } from "./modal";
import { PaneLayout, Resize } from "./panes";
import { ResultPanel } from "./results";
import { GlobalScrollbars } from "./scrollbars";
import { ThemeMenu, useTheme } from "./theme";
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
  definition?: boolean;
  languageSource?: string;
  languageDiagnostics?: readonly LanguageDiagnostic[];
}
interface WorkspaceProblem {
  code: string;
  message: string;
  severity: string;
  range?: { line: number; column: number; start?: number; end?: number };
  sourceRevision?: string;
  origin?: string;
  source?: string;
}
function App() {
  const [theme, setTheme] = useTheme();
  const [state, setState] = useState<State | null>(null),
    [documents, setDocuments] = useState<Record<string, Document>>({}),
    [layout, setLayout] = useState<Layout>(() => pane("@schema")),
    [activePane, setActivePane] = useState(""),
    [sidebar, setSidebar] = useState(238),
    [sidebarVisible, setSidebarVisible] = useState(true),
    [schemaSearch, setSchemaSearch] = useState(""),
    [palette, setPalette] = useState(false),
    [treeCreation, setTreeCreation] = useState<{ id: string; folder: boolean } | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [trust, setTrust] = useState(false),
    [closing, setClosing] = useState<{ paneId: string; tab: string } | null>(null),
    [selectedTable, setSelectedTable] = useState<string | null>(null),
    [lastFile, setLastFile] = useState(""),
    [navigation, setNavigation] = useState<{ paneId: string; file: string; range: LanguageRange } | null>(null),
    [compareA, setCompareA] = useState<string | undefined>();
  const stateRef = useRef<State | null>(null),
    activePaneRef = useRef(activePane),
    closingRef = useRef(closing),
    documentsRef = useRef(documents),
    layoutRef = useRef(layout),
    initialized = useRef(false),
    etag = useRef(""),
    loading = useRef(new Map<string, Promise<void>>()),
    analysisSources = useRef(new Map<string, string>()),
    analysisTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>()),
    storageKey = useRef("");
  documentsRef.current = documents;
  activePaneRef.current = activePane;
  closingRef.current = closing;
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
  const workingCopies = useMemo(
    () =>
      Object.values(documents)
        .filter((doc) => !doc.definition && doc.source !== doc.saved)
        .map(({ file, source, revision }) => ({ file, source, revision })),
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
      if (doc.definition) continue;
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
    setDocuments((current) => {
      const previous = current[file];
      if (!previous) return current;
      const next = { ...previous, ...patch };
      if (patch.source !== undefined && patch.source !== previous.source) {
        delete next.analysis;
        delete next.languageDiagnostics;
        delete next.languageSource;
      }
      return { ...current, [file]: next };
    });
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
  const formatFile = async (file: string) => {
    const doc = documentsRef.current[file];
    if (!doc?.writable) throw new Error("Format requires a file inside writeRoots.");
    if (stateRef.current?.classification === "production")
      throw new Error("Repository formatters are disabled on production-classified targets.");
    if (!stateRef.current?.trusted) {
      setTrust(true);
      return;
    }
    const result = await api<{ source: string; formatter: string; config: string }>("format", {
      file,
      source: doc.source,
      revision: doc.revision,
    });
    if (documentsRef.current[file]?.source !== doc.source || documentsRef.current[file]?.revision !== doc.revision)
      throw new Error("File changed while formatting. Your current edits are preserved; format again.");
    if (!panes(layoutRef.current).some((item) => item.tabs.includes(file))) return;
    setDocuments((current) => {
      const latest = current[file];
      if (
        !latest ||
        latest.source !== doc.source ||
        latest.revision !== doc.revision ||
        !panes(layoutRef.current).some((item) => item.tabs.includes(file))
      )
        return current;
      const next = { ...latest, source: result.source };
      if (latest.source !== result.source) delete next.analysis;
      return { ...current, [file]: next };
    });
    setNotice(`Formatted with ${result.formatter} · ${result.config}`);
  };
  const navigate = async (paneId: string, location: LanguageLocation) => {
    if (location.file && stateRef.current?.files.includes(location.file)) {
      await load(location.file);
      openTab(paneId, location.file);
      setNavigation({ paneId, file: location.file, range: location.range });
      return;
    }
    if (!location.token) throw new Error("This definition is outside the available project files.");
    const target = await api<{ file: string; source: string; revision: string }>("editor", {
      method: "readDefinition",
      token: location.token,
    });
    const file = `[definition] ${target.file}`;
    setDocuments((current) => ({
      ...current,
      [file]: {
        file,
        source: target.source,
        saved: target.source,
        revision: target.revision,
        writable: false,
        mode: "file",
        exportName: "run",
        readOnly: true,
        parameters: {},
        definition: true,
      },
    }));
    setLayout((current) => open(current, paneId, file));
    setActivePane(paneId);
    setNavigation({ paneId, file, range: location.range });
  };
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
    const doc = documentsRef.current[tab];
    if (!discard && !bypass && doc && doc.source !== doc.saved && !other) {
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
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const formatting = event.shiftKey && event.altKey && event.code === "KeyF" && !event.metaKey && !event.ctrlKey;
      if (!(event.metaKey || event.ctrlKey || formatting) || (event.altKey && !formatting) || event.isComposing) return;
      const name = event.key.toLowerCase();
      let command: (() => void) | undefined;
      const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).at(-1);
      const currentPane =
        panes(layoutRef.current).find((item) => item.id === activePaneRef.current) ?? panes(layoutRef.current)[0]!;
      if (formatting)
        command = () => {
          if (!dialog && !isTool(currentPane.active) && !busy) void action(() => formatFile(currentPane.active));
        };
      else if ((!event.shiftKey && name === "k") || (event.shiftKey && name === "p")) {
        command = () => {
          if (!dialog || dialog.getAttribute("aria-label") === "Command palette") setPalette((value) => !value);
        };
      } else if (!event.shiftKey && name === "b")
        command = () => {
          if (!dialog) setSidebarVisible((value) => !value);
        };
      else if (event.code === "Backslash")
        command = () => {
          if (!dialog && panes(layoutRef.current).length < 8)
            split(currentPane.id, event.shiftKey ? "bottom" : "right");
        };
      else if (!event.shiftKey && name === "w")
        command = () => {
          if (!dialog && currentPane.active) closeTab(currentPane.id, currentPane.active);
        };
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      command();
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  });
  useEffect(() => {
    const dismiss = (event: PointerEvent | KeyboardEvent) => {
      const isEscape = event instanceof KeyboardEvent && event.key === "Escape";
      if (event instanceof KeyboardEvent && !isEscape) return;
      if (isEscape && document.querySelector('[role="dialog"]')) return;
      let closed = false;
      for (const menu of document.querySelectorAll<HTMLDetailsElement>(".file-menu[open]")) {
        if (!isEscape && event.target instanceof Node && menu.contains(event.target)) continue;
        menu.open = false;
        if (isEscape) menu.querySelector("summary")?.focus();
        closed = true;
      }
      if (isEscape && closed) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const choose = (event: MouseEvent) => {
      if (event.target instanceof Element)
        event.target.closest<HTMLButtonElement>(".file-menu button")?.closest("details")?.removeAttribute("open");
    };
    document.addEventListener("click", choose);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", dismiss, true);
    return () => {
      document.removeEventListener("click", choose);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", dismiss, true);
    };
  }, []);
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
  const problemsFor = (doc: Document): WorkspaceProblem[] => {
    const normalized = doc.source.replaceAll("\r\n", "\n");
    const language = doc.languageSource === normalized ? (doc.languageDiagnostics ?? []) : [];
    const result: WorkspaceProblem[] = [...(doc.analysis?.diagnostics ?? [])];
    for (const diagnostic of language) {
      const start = offsetAt(normalized, diagnostic.range.start);
      const end = offsetAt(normalized, diagnostic.range.end);
      if (start === undefined || end === undefined) continue;
      result.push({
        code: String(diagnostic.code ?? diagnostic.source ?? "Editor"),
        message: diagnostic.message,
        severity:
          diagnostic.severity === 2
            ? "warning"
            : diagnostic.severity === 3 || diagnostic.severity === 4
              ? "info"
              : "error",
        origin: "language-server",
        source: diagnostic.source ?? "Editor",
        range: { line: diagnostic.range.start.line + 1, column: diagnostic.range.start.character + 1, start, end },
      });
    }
    const latest = state?.runs.find((run) => run.file === doc.file);
    if (doc.source === doc.saved && latest?.sourceRevision === doc.revision)
      result.push(...(latest.diagnostics ?? []).filter((problem) => problem.sourceRevision === doc.revision));
    return mergeDocumentDiagnostics(result);
  };
  const bottom = (item: Pane, doc: Document) => {
    if (item.bottom === "results") {
      const run = state!.runs.find((run) => run.id === item.runId) ?? state!.runs.find((run) => run.file === doc.file);
      return (
        <ResultPanel
          key={run?.id ?? "unexecuted"}
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
          {problemsFor(doc).length ? (
            problemsFor(doc).map((problem) => (
              <div className={problem.severity} key={JSON.stringify(problem)}>
                <code>{problem.code}</code>
                <span>{problem.message}</span>
                <small>
                  {problem.range ? `${problem.range.line}:${problem.range.column}` : (problem.source ?? problem.origin)}
                </small>
              </div>
            ))
          ) : (
            <div className="quiet-empty">No compiler, editor or database diagnostics for this file.</div>
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
              {(["sql", "ts"] as const).map((extension) => (
                <button
                  key={extension}
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const table = state.board.tables.find((value) => value.id === selectedTable);
                      if (!table) return;
                      const base = table.name.replace(/[^a-zA-Z0-9_-]/gu, "_") || "query";
                      let ordinal = 1;
                      let file = `${state.scratchDirectory}/${base}.${extension}`;
                      while (state.files.includes(file) || documentsRef.current[file])
                        file = `${state.scratchDirectory}/${base}-${++ordinal}.${extension}`;
                      await api("create-query", { table: table.id, file });
                      await refresh();
                      openTab(item.id, file);
                    })
                  }
                >
                  New {extension.toUpperCase()} query
                </button>
              ))}
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
    if (doc.definition)
      return (
        <div className="document-workspace">
          <div className="document-toolbar">
            <span className="document-path" title={doc.file}>
              {doc.file}
            </span>
            <span>Read-only definition</span>
          </div>
          <div className="document-editor" style={{ flex: "1 1 0" }}>
            <Editor
              session={`${state.project.name}:${item.id}:${doc.file}`}
              file={doc.file}
              source={doc.source}
              revision={doc.revision}
              readOnly
              active={item.id === focused.id}
              {...(navigation?.paneId === item.id && navigation.file === doc.file ? { reveal: navigation.range } : {})}
              onChange={() => {}}
              onSave={() => {}}
              onRun={() => {}}
            />
          </div>
        </div>
      );
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
              <button
                type="button"
                disabled={busy || !doc.writable || state.classification === "production"}
                onClick={() => void action(() => formatFile(doc.file))}
                title="Format file (Shift+Alt+F)"
              >
                Format file
              </button>
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
              <Icon name="play" /> Run
            </button>
          )}
        </div>
        <div className="document-editor" style={{ flex: `${1 - item.bottomRatio} 1 0` }}>
          <Editor
            session={`${state.project.name}:${item.id}:${doc.file}`}
            file={doc.file}
            source={doc.source}
            revision={doc.revision}
            languageEnabled={state.trusted}
            workingCopies={workingCopies}
            active={item.id === focused.id}
            diagnostics={problemsFor(doc).flatMap((problem) =>
              problem.range && problem.origin !== "language-server" ? [{ ...problem, range: problem.range }] : [],
            )}
            {...(navigation?.paneId === item.id && navigation.file === doc.file ? { reveal: navigation.range } : {})}
            onNavigate={(location) => void action(() => navigate(item.id, location))}
            onFormat={() => void action(() => formatFile(doc.file))}
            onDiagnostics={(source, diagnostics) =>
              setDocuments((current) => {
                const latest = current[doc.file];
                if (!latest || latest.source.replaceAll("\r\n", "\n") !== source) return current;
                if (
                  latest.languageSource === source &&
                  JSON.stringify(latest.languageDiagnostics) === JSON.stringify(diagnostics)
                )
                  return current;
                return {
                  ...current,
                  [doc.file]: { ...latest, languageSource: source, languageDiagnostics: diagnostics },
                };
              })
            }
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
                {tab === "problems" && problemsFor(doc).length ? <span>{problemsFor(doc).length}</span> : null}
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
  const problems = Object.values(documents).reduce((sum, doc) => sum + problemsFor(doc).length, 0);
  const activeDoc =
    !isTool(focused.active) && !documents[focused.active]?.definition ? documents[focused.active] : undefined;
  const connect = () =>
    void action(async () => {
      await api(state.connection.state === "connected" ? "refresh" : "connect", {});
      await refresh();
    });
  const createEntry = (folder: boolean) => {
    setSidebarVisible(true);
    setTreeCreation({ id: crypto.randomUUID(), folder });
  };
  const commands: PaletteCommand[] = [
    { id: "open-schema", label: "Open schema", icon: "schema", run: () => openTab(focused.id, "@schema") },
    { id: "open-compare", label: "Open compare", icon: "compare", run: () => openTab(focused.id, "@compare") },
    { id: "open-agent", label: "Open agent", icon: "agent", run: () => openTab(focused.id, "@agent") },
    { id: "new-file", label: "New file", icon: "new-file", run: () => createEntry(false) },
    { id: "new-folder", label: "New folder", icon: "new-folder", run: () => createEntry(true) },
    {
      id: "tree",
      label: sidebarVisible ? "Hide file tree" : "Show file tree",
      icon: "sidebar",
      shortcut: "⌘B / Ctrl+B",
      run: () => setSidebarVisible((value) => !value),
    },
    ...(["system", "light", "dark"] as const).map((value) => ({
      id: `theme-${value}`,
      label: `Theme: ${value[0]!.toUpperCase() + value.slice(1)}`,
      icon: (value === "system" ? "system" : value === "dark" ? "moon" : "sun") as "system" | "moon" | "sun",
      run: () => setTheme(value),
    })),
  ];
  if (state.target)
    commands.push({
      id: "connect",
      label: state.connection.state === "connected" ? "Refresh schema" : "Connect to target",
      icon: "connection",
      run: connect,
    });
  if (state.classification !== "production")
    commands.push({
      id: "trust",
      label: state.trusted ? "Disable trusted project execution" : "Enable trusted project execution",
      icon: "lock",
      run: () => {
        if (state.trusted)
          void action(async () => {
            await api("trust", { enable: false });
            await refresh();
          });
        else setTrust(true);
      },
    });
  if (panes(layout).length < 8)
    for (const edge of ["left", "right", "top", "bottom"] as const)
      commands.push({
        id: `split-${edge}`,
        label: `Split editor ${edge}`,
        icon: "split",
        shortcut: edge === "right" ? "⌘\\ / Ctrl+\\" : edge === "bottom" ? "⌘⇧\\ / Ctrl+Shift+\\" : "",
        run: () => split(focused.id, edge),
      });
  if (focused.active)
    commands.push({
      id: "close",
      label: "Close active tab",
      icon: "close",
      shortcut: "⌘W / Ctrl+W",
      run: () => closeTab(focused.id, focused.active),
    });
  if (activeDoc) {
    for (const [command, label, shortcut] of [
      ["completion", "Trigger suggestions", "Ctrl+Space / ⌘Space"],
      ["hover", "Show hover information", ""],
      ["definition", "Go to definition", "F12"],
      ["codeAction", "Quick fixes and code actions", "⌘. / Ctrl+."],
    ] as const)
      commands.push({
        id: `editor-${command}`,
        label,
        shortcut,
        icon: "file-ts",
        run: () => editorLanguageCommand(`${state.project.name}:${focused.id}:${activeDoc.file}`, command),
      });
    commands.push(
      {
        id: "find",
        label: "Find in active file",
        icon: "search",
        shortcut: "⌘F / Ctrl+F",
        run: () => {
          findInEditor(`${state.project.name}:${focused.id}:${activeDoc.file}`);
        },
      },
      {
        id: "reload",
        label: "Reload active file from disk",
        icon: "refresh",
        run: () => void action(() => fileAction(activeDoc.file, "reload")),
      },
      {
        id: "copy",
        label: "Save active file as…",
        icon: "new-file",
        run: () => void action(() => fileAction(activeDoc.file, "copy")),
      },
    );
    if (activeDoc.writable && activeDoc.source !== activeDoc.saved)
      commands.push({
        id: "save",
        label: "Save active file",
        icon: "check",
        shortcut: "⌘S / Ctrl+S",
        run: () =>
          void action(async () => {
            await save(activeDoc.file);
          }),
      });
    if (activeDoc.writable && !busy && state.classification !== "production")
      commands.push({
        id: "format",
        label: "Format active file",
        icon: "file-ts",
        shortcut: "Shift+Alt+F",
        run: () => void action(() => formatFile(activeDoc.file)),
      });
    if (activeDoc.writable)
      commands.push({
        id: "rename",
        label: "Rename active file…",
        icon: "file-ts",
        run: () => void action(() => fileAction(activeDoc.file, "rename")),
      });
    if (activeDoc.file.endsWith(".sql"))
      commands.push({
        id: "sql-types",
        label: "Generate SQL declarations",
        icon: "file-ts",
        run: () => void action(() => fileAction(activeDoc.file, "types")),
      });
    if (state.target && !busy && !(state.classification === "production" && activeDoc.mode !== "sql"))
      commands.push({
        id: "run",
        label: "Run active file",
        icon: "play",
        shortcut: "⌘Enter / Ctrl+Enter",
        run: () => void action(() => run(activeDoc.file)),
      });
    for (const bottom of ["results", "types", "bindings", "problems"] as const)
      commands.push({
        id: `show-${bottom}`,
        label: `Show ${bottom}`,
        icon: bottom === "problems" ? "warning" : "file-ts",
        run: () => setLayout((current) => changePane(current, focused.id, (value) => ({ ...value, bottom }))),
      });
  }
  const running = state.runs.find((value) => value.status === "running" || value.status === "checking");
  if (running)
    commands.push({
      id: "cancel",
      label: "Cancel active run",
      icon: "close",
      run: () =>
        void action(async () => {
          await api("cancel", { id: running.id });
          await refresh();
        }),
    });
  return (
    <div className="app-shell">
      <GlobalScrollbars />
      {error ? (
        <div className="workspace-banner error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError("")}>
            <Icon name="close" />
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="workspace-banner" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice("")}>
            <Icon name="close" />
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
              <WorkspaceFileTree
                files={state.files.filter((file) => !/\.d\.[cm]?ts$/u.test(file))}
                folders={state.folders ?? []}
                project={state.project.name}
                selected={focusedFile}
                scratch={state.scratchDirectory}
                creation={treeCreation}
                onOpen={(file) => openTab(focused.id, file)}
                onCreate={async (path, folder) => {
                  if (folder) await api("folder", { folder: path });
                  else await api("save", { file: path, source: "", revision: null });
                  await refresh();
                  if (!folder) openTab(focused.id, path);
                }}
              />
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
        <div className="status-actions">
          <button
            type="button"
            className="status-icon"
            aria-label="Toggle project tree"
            aria-keyshortcuts="Meta+B Control+B"
            title="Toggle project tree (⌘B / Ctrl+B)"
            onClick={() => setSidebarVisible((value) => !value)}
          >
            <Icon name="sidebar" />
          </button>
          <button
            type="button"
            className="status-icon"
            aria-label="Command palette"
            title="Command palette (⌘K / Ctrl+K)"
            onClick={() => setPalette(true)}
          >
            <Icon name="command" />
          </button>
          <button
            type="button"
            className="status-diagnostics"
            aria-label="Show SQL diagnostics"
            title={`${problems} SQL diagnostics${dirty.size ? ` · ${dirty.size} unsaved files` : ""}`}
            onClick={() => {
              if (activeDoc)
                setLayout((current) => changePane(current, focused.id, (value) => ({ ...value, bottom: "problems" })));
              else setPalette(true);
            }}
          >
            <Icon name={problems ? "warning" : "check"} />
            {problems || ""}
            {dirty.size ? <span> · {dirty.size} unsaved</span> : null}
          </button>
        </div>
        <div className="status-actions">
          {state.target ? (
            <button
              type="button"
              className="status-icon status-connection"
              disabled={busy}
              aria-label={state.connection.state === "connected" ? "Refresh schema" : "Connect to target"}
              title={`${state.connection.state} · ${state.connection.identity?.database ?? state.target} · ${state.grammar} · ${state.schemaSource} schema`}
              onClick={connect}
            >
              <span className={`status-dot ${state.connection.state === "connected" ? "succeeded" : ""}`} />
              <Icon name="connection" />
            </button>
          ) : null}
          <button
            type="button"
            className="status-icon"
            aria-label="Schema"
            title="Open schema"
            onClick={() => openTab(focused.id, "@schema")}
          >
            <Icon name="schema" />
          </button>
          <button
            type="button"
            className="status-icon"
            aria-label="Compare"
            title="Open compare"
            onClick={() => openTab(focused.id, "@compare")}
          >
            <Icon name="compare" />
          </button>
          <button
            type="button"
            className="status-icon"
            aria-label="Agent"
            title="Open agent"
            onClick={() => openTab(focused.id, "@agent")}
          >
            <Icon name="agent" />
          </button>
          {state.classification !== "production" ? (
            <button
              type="button"
              className={`status-icon ${state.trusted ? "trusted" : ""}`}
              aria-label={state.trusted ? "Disable trusted project execution" : "Enable trusted project execution"}
              title={state.trusted ? "Trusted project execution enabled" : "Project execution disabled"}
              onClick={() => {
                if (state.trusted)
                  void action(async () => {
                    await api("trust", { enable: false });
                    await refresh();
                  });
                else setTrust(true);
              }}
            >
              <Icon name="lock" />
            </button>
          ) : null}
          <ThemeMenu theme={theme} onChange={setTheme} />
        </div>
      </footer>
      {palette ? (
        <CommandPalette
          files={state.files.filter((file) => !/\.d\.[cm]?ts$/u.test(file))}
          commands={commands}
          onFile={(file) => openTab(focused.id, file)}
          onClose={() => setPalette(false)}
        />
      ) : null}
      {trust ? (
        <Modal className="create-dialog" label="Enable project execution" onClose={() => setTrust(false)}>
          <h3>Enable trusted project execution?</h3>
          <p>
            Project files, repository formatters and local agents can access your files, environment, network and
            private database clients. Managed read-only controls do not restrict those private clients.
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
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const pending = closing;
                  const source = documentsRef.current[pending.tab]?.source;
                  const revision = await save(pending.tab);
                  if (
                    closingRef.current !== pending ||
                    !revision ||
                    documentsRef.current[pending.tab]?.source !== source
                  )
                    return;
                  closeTab(pending.paneId, pending.tab, false, true);
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
