import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "./api";
import {
  type ExplorerNode,
  explorerTree,
  type InspectionTarget,
  inspectionTab,
  objectPresence,
} from "./explorer-model";
import type { ExplorerCatalog, ExplorerObject } from "./explorer-types";
import { Icon, type IconName } from "./icon";
import { FILE_MIME } from "./layout";
import "./explorer.css";

export function useExplorerCatalog(identity: string) {
  const [catalog, setCatalog] = useState<ExplorerCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const serial = useRef(0);
  const refreshing = useRef(false);
  const load = useCallback(async (refresh = false) => {
    if (!refresh && refreshing.current) return;
    if (refresh) refreshing.current = true;
    const request = ++serial.current;
    setLoading(true);
    setError("");
    try {
      const next = await api<ExplorerCatalog>(refresh ? "explorer/refresh" : "explorer", refresh ? {} : undefined);
      if (serial.current === request) setCatalog(next);
    } catch (error) {
      if (serial.current === request) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (serial.current === request) {
        refreshing.current = false;
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    if (!identity) return;
    void load();
  }, [identity, load]);
  useEffect(
    () => () => {
      serial.current++;
    },
    [],
  );
  return { catalog, loading, error, refresh: () => void load(true) };
}
export function objectIcon(kind: string): IconName {
  const icons: Record<string, IconName> = {
    namespace: "database",
    table: "table",
    view: "table",
    "materialized-view": "table",
    column: "column",
    enum: "enum",
    domain: "enum",
    index: "index",
    constraint: "constraint",
    relationship: "relationship",
    routine: "file-ts",
    function: "file-ts",
    group: "folder",
  };
  return icons[kind] ?? "schema";
}
function ObjectTree({
  objects,
  selected,
  onOpen,
}: {
  objects: ExplorerObject[];
  selected?: string | undefined;
  onOpen: (target: InspectionTarget) => void;
}) {
  const nodes = useMemo(() => explorerTree(objects), [objects]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(nodes.map((node) => node.id)));
  const [focus, setFocus] = useState("");
  const tree = useRef<HTMLDivElement>(null);
  const treeId = useId();
  const toggle = (id: string) =>
    setExpanded((value) => {
      const next = new Set(value);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const move = (id: string) => {
    setFocus(id);
    tree.current?.querySelectorAll<HTMLButtonElement>("[role=treeitem]").forEach((button) => {
      if (button.dataset.object === id) button.focus();
    });
  };
  const rows = (items: ExplorerNode[], depth: number, parent = "") =>
    items.map((node) => {
      const presence = objectPresence(node.object);
      return (
        <div role="none" key={node.id}>
          <button
            type="button"
            role="treeitem"
            className={`explorer-row ${selected === node.id ? "selected" : ""} ${presence ?? ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            data-object={node.id}
            data-parent={parent}
            aria-label={`${node.label} ${node.kind}${presence ? ` ${presence}` : ""}`}
            aria-level={depth + 1}
            aria-expanded={node.children.length ? expanded.has(node.id) : undefined}
            aria-owns={
              node.children.length && expanded.has(node.id) ? `${treeId}-${encodeURIComponent(node.id)}` : undefined
            }
            aria-selected={node.object ? selected === node.id : undefined}
            tabIndex={focus === node.id || (!focus && node.id === nodes[0]?.id) ? 0 : -1}
            title={
              node.object
                ? `${node.object.namespace ? `${node.object.namespace}.` : ""}${node.label} · ${node.kind}`
                : node.label
            }
            draggable={!!node.object}
            onDragStart={(event) => {
              if (node.object) {
                event.dataTransfer.setData(
                  FILE_MIME,
                  JSON.stringify({ tab: inspectionTab({ kind: "object", id: node.id, label: node.label }) }),
                );
                event.dataTransfer.effectAllowed = "copy";
              }
            }}
            onFocus={() => setFocus(node.id)}
            onClick={(event) => {
              if (
                node.children.length &&
                (!node.object || (event.target instanceof Element && event.target.closest(".explorer-chevron")))
              )
                toggle(node.id);
              else if (node.object) onOpen({ kind: "object", id: node.id, label: node.label });
            }}
            onDoubleClick={() => {
              if (node.children.length && node.object) toggle(node.id);
            }}
            onKeyDown={(event) => {
              const buttons = [...(tree.current?.querySelectorAll<HTMLButtonElement>("[role=treeitem]") ?? [])];
              const index = buttons.indexOf(event.currentTarget);
              if (["ArrowDown", "ArrowUp", "Home", "End", "ArrowRight", "ArrowLeft"].includes(event.key))
                event.preventDefault();
              else return;
              if (event.key === "ArrowDown")
                move(buttons[Math.min(buttons.length - 1, index + 1)]?.dataset.object ?? node.id);
              if (event.key === "ArrowUp") move(buttons[Math.max(0, index - 1)]?.dataset.object ?? node.id);
              if (event.key === "Home") move(buttons[0]?.dataset.object ?? node.id);
              if (event.key === "End") move(buttons.at(-1)?.dataset.object ?? node.id);
              if (event.key === "ArrowRight" && node.children.length) {
                if (!expanded.has(node.id)) toggle(node.id);
                else move(node.children[0]!.id);
              }
              if (event.key === "ArrowLeft") {
                if (node.children.length && expanded.has(node.id)) toggle(node.id);
                else if (parent) move(parent);
              }
            }}
          >
            <span className={`explorer-chevron ${expanded.has(node.id) ? "expanded" : ""}`}>
              {node.children.length ? <Icon name="chevron" /> : null}
            </span>
            <Icon name={objectIcon(node.kind)} />
            <span className="explorer-name">{node.label}</span>
            {presence ? (
              <span className="explorer-presence">{presence === "removed" ? "Removed" : "History"}</span>
            ) : null}
            {node.kind === "group" ? <span className="explorer-count">{node.children.length}</span> : null}
          </button>
          {node.children.length && expanded.has(node.id) ? (
            // biome-ignore lint/a11y/useSemanticElements: ARIA tree groups nest treeitems; a fieldset changes the tree keyboard model.
            <div role="group" id={`${treeId}-${encodeURIComponent(node.id)}`}>
              {rows(node.children, depth + 1, node.id)}
            </div>
          ) : null}
        </div>
      );
    });
  return (
    <div ref={tree} className="explorer-tree" role="tree" aria-label="Database objects">
      {rows(nodes, 0)}
    </div>
  );
}
export function ExplorerSidebar({
  catalog,
  loading,
  error,
  selected,
  onOpen,
  onRefresh,
  focusRequest,
}: {
  focusRequest?: { section: "database" | "migrations"; id: string } | undefined;
  catalog: ExplorerCatalog | null;
  loading: boolean;
  error: string;
  selected?: InspectionTarget | undefined;
  onOpen: (target: InspectionTarget) => void;
  onRefresh: () => void;
}) {
  const [databaseOpen, setDatabaseOpen] = useState(true),
    [migrationsOpen, setMigrationsOpen] = useState(true);
  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.section === "database") setDatabaseOpen(true);
    else setMigrationsOpen(true);
    const frame = requestAnimationFrame(() =>
      document
        .querySelector<HTMLButtonElement>(
          focusRequest.section === "database" ? '#database-explorer [role="treeitem"]' : "#migration-explorer button",
        )
        ?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);
  return (
    <>
      <section
        className={`explorer-section database-section ${databaseOpen ? "expanded" : ""}`}
        aria-label="Database explorer"
      >
        <div className="tree-heading">
          <button
            type="button"
            className="explorer-section-toggle"
            aria-expanded={databaseOpen}
            aria-controls="database-explorer"
            onClick={() => setDatabaseOpen((value) => !value)}
          >
            <Icon name="chevron" />
            <span>Database</span>
          </button>
          <button
            type="button"
            className="explorer-refresh"
            aria-label="Refresh database and migration explorers"
            title="Refresh captured schema and migration history"
            disabled={loading}
            onClick={onRefresh}
          >
            <Icon name="refresh" />
          </button>
        </div>
        {databaseOpen ? (
          <div id="database-explorer" className="explorer-section-body">
            {error ? (
              <p className="explorer-message" role="alert">
                {error}
              </p>
            ) : null}
            {catalog ? (
              <ObjectTree
                objects={catalog.schema.objects}
                selected={selected?.kind === "object" ? selected.id : undefined}
                onOpen={onOpen}
              />
            ) : (
              <p className="explorer-message">{loading ? "Loading database objects…" : "Schema unavailable."}</p>
            )}
            {catalog && !catalog.schema.objects.length ? (
              <p className="explorer-message">No objects in the captured schema.</p>
            ) : null}
          </div>
        ) : null}
      </section>
      <section
        className={`explorer-section migrations-section ${migrationsOpen ? "expanded" : ""}`}
        aria-label="Migration explorer"
      >
        <div className="tree-heading">
          <button
            type="button"
            className="explorer-section-toggle"
            aria-expanded={migrationsOpen}
            aria-controls="migration-explorer"
            onClick={() => setMigrationsOpen((value) => !value)}
          >
            <Icon name="chevron" />
            <span>Migrations</span>
            {catalog ? <span className="explorer-count">{catalog.migrations.entries.length}</span> : null}
          </button>
        </div>
        {migrationsOpen ? (
          <nav id="migration-explorer" className="explorer-section-body" aria-label="Project migrations">
            {catalog?.migrations.message && catalog.migrations.state !== "ready" ? (
              <p className="explorer-message" role={catalog.migrations.state === "failed" ? "alert" : undefined}>
                {catalog.migrations.message}
              </p>
            ) : null}
            {catalog?.migrations.entries.map((migration) => (
              <button
                type="button"
                className={`explorer-row migration-row ${selected?.kind === "migration" && selected.id === migration.id ? "selected" : ""}`}
                key={migration.id}
                title={`${migration.id} · ${migration.status}`}
                aria-current={selected?.kind === "migration" && selected.id === migration.id ? "page" : undefined}
                onClick={() => onOpen({ kind: "migration", id: migration.id, label: migration.id })}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(
                    FILE_MIME,
                    JSON.stringify({
                      tab: inspectionTab({ kind: "migration", id: migration.id, label: migration.id }),
                    }),
                  );
                  event.dataTransfer.effectAllowed = "copy";
                }}
              >
                <Icon name="migration" />
                <span className="explorer-name">{migration.id}</span>
                <span className={`migration-status ${migration.status}`}>{migration.status}</span>
              </button>
            ))}
            {catalog?.migrations.state === "ready" && !catalog.migrations.entries.length ? (
              <p className="explorer-message">No migrations found.</p>
            ) : null}
            {!catalog ? (
              <p className="explorer-message">{loading ? "Loading migrations…" : "Migration history unavailable."}</p>
            ) : null}
          </nav>
        ) : null}
      </section>
    </>
  );
}
