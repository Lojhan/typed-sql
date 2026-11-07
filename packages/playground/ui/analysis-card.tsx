import { defineCatalog, type Spec } from "@json-render/core";
import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react";
import { schema } from "@json-render/react/schema";
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { z } from "zod/v4";
import type {
  AnalysisCapture,
  AnalysisDataset,
  AnalysisFilter,
  AnalysisView,
  FilterValues,
} from "../src/analysis-contract";
import { capturedCsv, cellText, filteredRows, metricComparison, metricValue } from "../src/analysis-model";
import { AnalysisTable } from "./analysis-table";
import { api } from "./api";
import {
  Bar,
  BarLabel,
  Button,
  ControlGroup,
  EmptyState,
  FieldLabel,
  Input,
  Notice,
  Panel,
  Select,
  Tab,
  TabBar,
  View,
} from "./components";
import { Modal } from "./modal";
import { RichOutputBoundary } from "./rich-output-boundary";
import "./agent-rich.css";

const Chart = lazy(() => import("./analysis-chart"));
const Markdown = lazy(() => import("./agent-markdown"));

function download(name: string, source: string, type: string) {
  const url = URL.createObjectURL(new Blob([source], { type })),
    link = document.createElement("a");
  link.download = name;
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
interface Context {
  capture: AnalysisCapture;
  rows: AnalysisDataset["rows"];
  filters: FilterValues;
  setFilter: (id: string, value: FilterValues[string]) => void;
  onSelection: (filter: string, value: string) => void;
}
const AnalysisContext = createContext<Context | null>(null);
const useAnalysisContext = () => {
  const value = useContext(AnalysisContext);
  if (!value) throw new Error("Missing analysis context");
  return value;
};
function FilterControl({ filter }: { filter: AnalysisFilter }) {
  const { capture, filters, setFilter } = useAnalysisContext();
  const options =
    filter.options ?? [...new Set(capture.dataset.rows.map((row) => cellText(row[filter.column])))].slice(0, 200);
  const value =
    filters[filter.id] ?? (filter.mode === "query" ? cellText(capture.dataset.values[filter.parameter!]) : "");
  return (
    <FieldLabel className="analysis-filter">
      <span>
        {filter.label}
        {filter.mode === "query" ? <small>Runs query</small> : null}
      </span>
      {filter.kind === "select" || filter.kind === "multiselect" ? (
        <Select
          aria-label={filter.label}
          multiple={filter.kind === "multiselect"}
          value={filter.kind === "multiselect" ? (Array.isArray(value) ? value : []) : String(value)}
          onChange={(event) =>
            setFilter(
              filter.id,
              filter.kind === "multiselect"
                ? [...event.target.selectedOptions].map((o) => o.value)
                : event.target.value,
            )
          }
        >
          {filter.kind === "select" && filter.mode === "captured" ? <option value="">All</option> : null}
          {options.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
      ) : filter.kind === "toggle" ? (
        <Input
          aria-label={filter.label}
          type="checkbox"
          checked={value === true || value === "true"}
          onChange={(event) => setFilter(filter.id, event.target.checked)}
        />
      ) : (
        <Input
          aria-label={filter.label}
          type={filter.kind === "number" ? "number" : filter.kind === "date" ? "date" : "search"}
          step={filter.kind === "number" ? "any" : undefined}
          value={filter.kind === "date" ? String(value).slice(0, 10) : String(value)}
          onChange={(event) => setFilter(filter.id, event.target.value)}
        />
      )}
    </FieldLabel>
  );
}
function ViewContent({ view }: { view: AnalysisView }) {
  const { rows, capture, onSelection } = useAnalysisContext();
  const select = useCallback(
    (name: string) => {
      if (view.linkFilter) onSelection(view.linkFilter, name);
    },
    [view, onSelection],
  );
  const [mode, setMode] = useState<"chart" | "data">("chart");
  const [exportChart, setExportChart] = useState<((format: "png" | "svg") => void) | null>(null);
  const ready = useCallback((fn: ((format: "png" | "svg") => void) | null) => setExportChart(() => fn), []);
  let metric = "",
    error = "";
  let comparison: ReturnType<typeof metricComparison> = null;
  if (view.kind === "metric")
    try {
      metric = metricValue(view, rows);
      comparison = metricComparison(view, rows);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  return (
    <Panel className="analysis-view" padding="none">
      <Bar>
        <BarLabel as="strong" truncate>
          {view.title}
        </BarLabel>
        {view.kind !== "metric" ? (
          <ControlGroup>
            <Button onClick={() => setMode(mode === "data" ? "chart" : "data")}>
              {mode === "data" ? "Chart" : "Data"}
            </Button>
            {view.kind !== "table" && mode === "chart" ? (
              <Select
                aria-label={`Export ${view.title}`}
                disabled={!exportChart}
                value=""
                onChange={(event) => {
                  if (event.target.value) exportChart?.(event.target.value as "png" | "svg");
                }}
              >
                <option value="">Export image</option>
                <option value="svg">SVG</option>
                <option value="png">PNG</option>
              </Select>
            ) : null}
          </ControlGroup>
        ) : null}
      </Bar>
      {view.description ? <p className="analysis-note">{view.description}</p> : null}
      {view.kind === "metric" ? (
        <div className="analysis-metric">
          {error ? (
            <Notice tone="error">{error}</Notice>
          ) : (
            <>
              <strong>{metric}</strong>
              {view.unit ? <span>{view.unit}</span> : null}
              {comparison ? (
                <span className="analysis-comparison">
                  {comparison.delta} ({comparison.percent}) · {view.compareLabel ?? "compared with baseline"}
                </span>
              ) : null}
            </>
          )}
          {view.x !== undefined && !error ? (
            <Suspense fallback={null}>
              <Chart compact view={{ ...view, kind: "line" }} rows={rows} />
            </Suspense>
          ) : null}
        </div>
      ) : view.kind === "table" || mode === "data" ? (
        <AnalysisTable dataset={capture.dataset} rows={rows} />
      ) : rows.length ? (
        <Suspense fallback={<EmptyState>Loading chart…</EmptyState>}>
          <RichOutputBoundary>
            <Chart view={view} rows={rows} onExportReady={ready} onSelect={select} />
          </RichOutputBoundary>
        </Suspense>
      ) : (
        <EmptyState>No rows match these filters.</EmptyState>
      )}
    </Panel>
  );
}
const catalog = defineCatalog(schema, {
  actions: {},
  components: {
    Stack: { props: z.object({}), slots: ["default"], description: "Vertical analysis layout" },
    Grid: { props: z.object({}), slots: ["default"], description: "Responsive analysis grid" },
    AnalysisView: { props: z.object({ id: z.string() }), slots: [], description: "A validated view of captured data" },
    Filter: { props: z.object({ id: z.string() }), slots: [], description: "A validated filter control" },
  },
});
const { registry } = defineRegistry(catalog, {
  components: {
    Stack: ({ children }) => <div className="analysis-stack">{children}</div>,
    Grid: ({ children }) => <div className="analysis-grid">{children}</div>,
    AnalysisView: ({ props }) => {
      const { capture } = useAnalysisContext();
      const view = capture.artifact.spec.views.find((view) => view.id === props.id);
      return view ? <ViewContent view={view} /> : null;
    },
    Filter: ({ props }) => {
      const { capture } = useAnalysisContext();
      const filter = capture.artifact.spec.filters.find((filter) => filter.id === props.id);
      return filter ? <FilterControl filter={filter} /> : null;
    },
  },
});
function renderSpec(type: "Stack" | "Grid", kind: "AnalysisView" | "Filter", ids: string[]): Spec {
  return {
    root: "root",
    elements: {
      root: { type, props: {}, children: ids.map((id) => `item-${id}`) },
      ...Object.fromEntries(ids.map((id) => [`item-${id}`, { type: kind, props: { id }, children: [] }])),
    },
  };
}
export function AnalysisCard({
  id,
  onOpen,
  onSaved,
  expanded = false,
}: {
  id: string;
  onOpen?: (id: string, title?: string) => void;
  onSaved?: (file: string) => void;
  expanded?: boolean;
}) {
  const [capture, setCapture] = useState<AnalysisCapture | null>(null),
    [filters, setFilters] = useState<FilterValues>({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [mode, setMode] = useState<"chart" | "data" | "query">("chart"),
    [save, setSave] = useState(false),
    [file, setFile] = useState("");
  const [remove, setRemove] = useState(false),
    [removed, setRemoved] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setCapture(null);
    setError("");
    void api<AnalysisCapture>(`analyses/capture?id=${encodeURIComponent(id)}`).then(
      (next) => {
        if (!cancelled) {
          setCapture(next);
          setFilters(next.artifact.filters);
        }
      },
      (error) => {
        if (!cancelled) setError(error.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id]);
  const rows = useMemo(
    () => (capture ? filteredRows(capture.dataset, capture.artifact.spec.filters, capture.artifact.filters) : []),
    [capture],
  );
  const setFilter = useCallback(
    (id: string, value: FilterValues[string]) => setFilters((current) => ({ ...current, [id]: value })),
    [],
  );
  if (removed) return <EmptyState>Analysis removed from private storage. Project definitions are retained.</EmptyState>;
  if (!capture) return <EmptyState error={!!error}>{error || "Loading analysis…"}</EmptyState>;
  const { artifact, dataset } = capture,
    spec = artifact.spec;
  const viewSpec = renderSpec(
    spec.layout === "grid" ? "Grid" : "Stack",
    "AnalysisView",
    spec.views.map((view) => view.id),
  );
  const controlSpec = renderSpec(
    "Grid",
    "Filter",
    spec.filters.map((filter) => filter.id),
  );
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const apply = (values: FilterValues) =>
    void act(async () => {
      const next = await api<AnalysisCapture>("analyses/filters", { id, revision: artifact.revision, values });
      setCapture(next);
      setFilters(next.artifact.filters);
    });
  return (
    <Panel className={`analysis-card ${expanded ? "expanded" : ""}`} padding="none">
      <Bar wrap>
        <BarLabel as="strong">{spec.title}</BarLabel>
        <ControlGroup wrap>
          {onOpen ? <Button onClick={() => onOpen(id, spec.title)}>Open in workspace</Button> : null}
          <Button disabled={busy} onClick={() => setSave((value) => !value)}>
            Save analysis
          </Button>
          {expanded ? (
            <Button variant="danger" disabled={busy} onClick={() => setRemove(true)}>
              Remove analysis
            </Button>
          ) : null}
          <Select
            aria-label="Export analysis"
            value=""
            onChange={(event) => {
              const kind = event.target.value;
              if (kind === "csv") download(`${spec.title}.csv`, capturedCsv(dataset.columns, rows), "text/csv");
              if (kind === "json")
                download(
                  `${spec.title}.json`,
                  JSON.stringify(
                    { columns: dataset.columns, rows, complete: dataset.complete, capturedAt: dataset.capturedAt },
                    null,
                    2,
                  ),
                  "application/json",
                );
            }}
          >
            <option value="">Export captured data</option>
            <option value="csv">CSV</option>
            <option value="json">Lossless JSON</option>
          </Select>
        </ControlGroup>
      </Bar>
      <TabBar aria-label="Analysis sections">
        <Tab aria-selected={mode === "chart"} onClick={() => setMode("chart")}>
          Chart
        </Tab>
        <Tab aria-selected={mode === "data"} onClick={() => setMode("data")}>
          Data
        </Tab>
        <Tab aria-selected={mode === "query"} onClick={() => setMode("query")}>
          Query
        </Tab>
      </TabBar>
      {remove ? (
        <Modal className="analysis-remove" label="Remove analysis" onClose={() => setRemove(false)}>
          <h3>Remove this captured analysis?</h3>
          <p>The private card and unshared captures are removed. Saved project definitions remain available.</p>
          <ControlGroup>
            <Button onClick={() => setRemove(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api("analyses/remove", { id, revision: artifact.revision });
                  setRemove(false);
                  setRemoved(true);
                })
              }
            >
              Remove captured analysis
            </Button>
          </ControlGroup>
        </Modal>
      ) : null}
      {error ? (
        <Notice tone="error" onDismiss={() => setError("")}>
          {error}
        </Notice>
      ) : null}
      {save ? (
        <Bar wrap>
          <Input
            aria-label="Analysis file path"
            placeholder="playground/users.analysis.json"
            value={file}
            onChange={(event) => setFile(event.target.value)}
          />
          <Button
            disabled={busy || !file.endsWith(".analysis.json")}
            onClick={() =>
              void act(async () => {
                const saved = await api<{ file: string }>("analyses/save", { id, file });
                onSaved?.(saved.file);
                setSave(false);
              })
            }
          >
            Save definition
          </Button>
          <Button onClick={() => setSave(false)}>Cancel</Button>
        </Bar>
      ) : null}
      <div className="analysis-body">
        {!dataset.complete ? (
          <Notice tone="warning">This is a partial capture. Totals and charts describe the captured subset.</Notice>
        ) : null}
        {artifact.initialDatasetId !== dataset.id ? (
          <Notice>
            Query parameters changed. The agent’s original explanation describes the initial capture; inspect the
            applied controls and Query for the current definition.
          </Notice>
        ) : null}
        {spec.description ? (
          <Suspense fallback={<p>{spec.description}</p>}>
            <Markdown text={spec.description} />
          </Suspense>
        ) : null}
        <AnalysisContext.Provider
          value={{
            capture,
            rows,
            filters,
            setFilter,
            onSelection: (id, value) => {
              if (busy) return;
              const filter = spec.filters.find((filter) => filter.id === id);
              if (
                filter?.mode !== "captured" ||
                filter.kind !== "select" ||
                (filter.options && !filter.options.includes(value))
              )
                return;
              const next = { ...artifact.filters, [id]: value };
              setFilters(next);
              apply(next);
            },
          }}
        >
          <JSONUIProvider registry={registry}>
            {spec.filters.length ? (
              <Panel className="analysis-controls">
                <fieldset disabled={busy}>
                  <Renderer spec={controlSpec} registry={registry} />
                  <ControlGroup>
                    <Button variant="primary" disabled={busy} onClick={() => apply(filters)}>
                      {busy ? "Applying…" : "Apply filters"}
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setFilters({});
                        apply({});
                      }}
                    >
                      Reset
                    </Button>
                  </ControlGroup>
                </fieldset>
              </Panel>
            ) : null}
            {mode === "chart" ? (
              <Renderer spec={viewSpec} registry={registry} />
            ) : mode === "data" ? (
              <AnalysisTable dataset={dataset} rows={rows} />
            ) : (
              <>
                <pre className="analysis-query">{dataset.source}</pre>
                <details>
                  <summary>Parameters and capture identity</summary>
                  <pre>
                    {JSON.stringify(
                      { values: dataset.values, identity: dataset.identity, schemaHash: dataset.schemaHash },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </>
            )}
          </JSONUIProvider>
        </AnalysisContext.Provider>
        <p className="analysis-provenance">
          {rows.length} of {dataset.rows.length} captured rows ·{" "}
          {dataset.complete ? "Complete captured query result" : "Partial result — not the full population"} ·{" "}
          {dataset.target} · {new Date(dataset.capturedAt).toLocaleString()}. Chart geometry uses approximate numeric
          coordinates; Data and JSON preserve exact values.
        </p>
      </div>
    </Panel>
  );
}
export function AnalysisWorkspace({ id, onSaved }: { id: string; onSaved: (file: string) => void }) {
  return (
    <View className="analysis-workspace">
      <AnalysisCard id={id} onSaved={onSaved} expanded />
    </View>
  );
}
export function SavedAnalysis({ file, onOpen }: { file: string; onOpen: (id: string, title?: string) => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <View>
      <Bar>
        <BarLabel>{file}</BarLabel>
        <Button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void api<AnalysisCapture>("analyses/open", { file })
              .then(
                (next) => onOpen(next.artifact.id, next.artifact.spec.title),
                (error) => setError(error.message),
              )
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Running read only…" : "Run saved analysis"}
        </Button>
      </Bar>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <EmptyState>
        Run this saved definition to capture current data. Opening the file does not execute its query.
      </EmptyState>
    </View>
  );
}
