import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarLabel, Button, ControlGroup } from "./components";
import { Icon } from "./icon.js";
import type { Board, Table } from "./types";
import "@xyflow/react/dist/style.css";

type TableNodeType = Node<{ table: Table; selectedTable: string | null }, "table">;
const TableNode = memo(function TableNode({ data }: NodeProps<TableNodeType>) {
  const table = data.table;
  return (
    <article className={`table-node ${data.selectedTable === table.id ? "is-selected" : ""}`}>
      <header>
        <span className="table-icon">
          <Icon name="schema" />
        </span>
        <div>
          <small>{table.namespace || "default"}</small>
          <strong>{table.name}</strong>
        </div>
        <span className="count-chip">{table.columns.length}</span>
      </header>
      {table.columns.map((column) => (
        <div className="table-column" key={column.name}>
          <Handle type="target" position={Position.Left} id={`target:${column.name}`} isConnectable={false} />
          <span className={`column-key ${column.primary ? "primary" : ""}`}>
            {column.primary ? "◆" : column.unique ? "◇" : "·"}
          </span>
          <span className="column-name">{column.name}</span>
          <code>{column.databaseType}</code>
          <span className="nullable">{column.nullable ? "?" : ""}</span>
          <Handle type="source" position={Position.Right} id={`source:${column.name}`} isConnectable={false} />
        </div>
      ))}
    </article>
  );
});
const nodeTypes = { table: TableNode };

/** Deterministic component/layer layout; only explicit reset or schema identity changes arrange cards. */
function initialPositions(board: Board): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  const visited = new Set<string>();
  const neighbors = new Map<string, string[]>();
  for (const table of board.tables) neighbors.set(table.id, []);
  for (const edge of board.edges) {
    if (neighbors.has(edge.source) && neighbors.has(edge.target)) {
      neighbors.get(edge.source)!.push(edge.target);
      neighbors.get(edge.target)!.push(edge.source);
    }
  }
  let componentX = 0,
    componentY = 0,
    rowHeight = 0;
  const rowWidth = Math.max(730, Math.min(2920, Math.ceil(Math.sqrt(board.tables.length)) * 365));
  for (const table of board.tables) {
    if (visited.has(table.id)) continue;
    const queue: [string, number][] = [[table.id, 0]];
    const layers = new Map<number, string[]>();
    for (let index = 0; index < queue.length; index++) {
      const [id, depth] = queue[index]!;
      if (visited.has(id)) continue;
      visited.add(id);
      const layer = layers.get(depth) ?? [];
      layer.push(id);
      layers.set(depth, layer);
      for (const next of neighbors.get(id) ?? []) if (!visited.has(next)) queue.push([next, depth + 1]);
    }
    const width = Math.max(...layers.keys(), 0) * 365 + 285;
    if (componentX && componentX + width > rowWidth) {
      componentX = 0;
      componentY += rowHeight + 50;
      rowHeight = 0;
    }
    let height = 0;
    for (const [depth, ids] of layers) {
      let y = 0;
      for (const id of ids) {
        const item = board.tables.find((table) => table.id === id)!;
        result.set(id, { x: componentX + depth * 365, y: componentY + y });
        y += 118 + item.columns.length * 30;
      }
      height = Math.max(height, y);
    }
    rowHeight = Math.max(rowHeight, height);
    componentX += width + 80;
  }
  return result;
}

export function SchemaBoard({
  board,
  selected,
  onSelect,
  onOpenTable,
  search,
  identity,
}: {
  board: Board;
  selected: string | null;
  onSelect: (id: string) => void;
  onOpenTable: (id: string) => void;
  search: string;
  identity: string;
}) {
  const [focus, setFocus] = useState(false);
  const [flow, setFlow] = useState<ReactFlowInstance<TableNodeType> | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [overview, setOverview] = useState(true);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect();
      setOverview(rect.width >= 260 && rect.height >= 180);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [nodes, setNodes] = useState<TableNodeType[]>([]);
  const visible = useMemo(() => {
    const matching = board.tables.filter((table) =>
      `${table.namespace}.${table.name} ${table.columns.map((c) => c.name).join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    );
    if (!focus || !selected) return matching.slice(0, 100);
    const ids = new Set([selected]);
    for (const edge of board.edges) {
      if (edge.source === selected) ids.add(edge.target);
      if (edge.target === selected) ids.add(edge.source);
    }
    return matching.filter((table) => ids.has(table.id)).slice(0, 100);
  }, [board, search, selected, focus]);
  const layout = useMemo(() => initialPositions({ ...board, tables: visible }), [board, visible]);
  const storageKey = `typed-sql-board-v1:${identity}`;
  const priorStorageKey = useRef(storageKey);
  useEffect(() => {
    let saved: Record<string, { x: number; y: number }> = {};
    try {
      saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    } catch {
      /* Invalid local display state never affects schema. */
    }
    const preserve = priorStorageKey.current === storageKey;
    priorStorageKey.current = storageKey;
    setNodes((current) => {
      const existing = new Map((preserve ? current : []).map((node) => [node.id, node]));
      return visible.map((table) => {
        const previous = existing.get(table.id);
        return {
          ...previous,
          id: table.id,
          type: "table",
          position: previous?.position ?? saved[table.id] ?? layout.get(table.id) ?? { x: 0, y: 0 },
          data: { table, selectedTable: selected },
        };
      });
    });
  }, [visible, layout, selected, storageKey]);
  const edges = useMemo(() => {
    const ids = new Set(visible.map((t) => t.id));
    return board.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .flatMap((edge) =>
        edge.columns.map((column, i) => ({
          id: `${edge.id}:${i}`,
          source: edge.source,
          target: edge.target,
          sourceHandle: `source:${column}`,
          targetHandle: `target:${edge.referencedColumns[i]}`,
          type: "smoothstep",
          animated: false,
          style: {
            stroke: selected === edge.source || selected === edge.target ? "var(--accent)" : "var(--board-edge)",
            strokeWidth: 1.5,
          },
          label: i === 0 ? edge.name : undefined,
        })),
      );
  }, [board.edges, visible, selected]);
  const changed = useCallback(
    (changes: NodeChange<TableNodeType>[]) => setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );
  const saveLayout = useCallback(() => {
    try {
      const prior = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<string, { x: number; y: number }>;
      for (const node of nodes) prior[node.id] = node.position;
      localStorage.setItem(storageKey, JSON.stringify(prior));
    } catch {
      /* Storage may be disabled. */
    }
  }, [nodes, storageKey]);
  const visibleKey = visible.map((table) => table.id).join("\0");
  useEffect(() => {
    if (!flow || !visibleKey) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        void flow.fitView({ padding: 0.18, maxZoom: 1, duration: 0 });
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [flow, visibleKey]);
  const notes = [
    ...(!board.capturedRelationships ? ["Relationships were not captured in this snapshot."] : []),
    ...(board.tables.length > 100 ? ["Showing up to 100 relations. Search or focus a relation to explore more."] : []),
  ];
  return (
    <div className="schema-canvas">
      <Bar wrap className="canvas-toolbar">
        <BarLabel truncate>
          <b>{visible.length}</b> of {board.tables.length} relations
        </BarLabel>
        <ControlGroup wrap>
          <Button
            className={focus ? "active" : ""}
            aria-pressed={focus}
            onClick={() => setFocus((value) => !value)}
            disabled={!selected}
          >
            Focus neighbors
          </Button>
          <Button
            onClick={() => {
              try {
                localStorage.removeItem(storageKey);
              } catch {
                /* Display storage may be disabled. */
              }
              setNodes((current) =>
                current.map((node) => ({ ...node, position: layout.get(node.id) ?? node.position })),
              );
              requestAnimationFrame(() =>
                requestAnimationFrame(() => void flow?.fitView({ padding: 0.18, maxZoom: 1, duration: 180 })),
              );
            }}
          >
            Reset layout
          </Button>
        </ControlGroup>
      </Bar>
      <div className="canvas-viewport" ref={viewport}>
        <ReactFlow
          onInit={setFlow}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={changed}
          onNodeClick={(_, node) => onSelect(node.id)}
          onNodeDoubleClick={(_, node) => onOpenTable(node.id)}
          zoomOnDoubleClick={false}
          onNodeDragStop={saveLayout}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.04}
          maxZoom={1.5}
          nodesConnectable={false}
          deleteKeyCode={null}
          onlyRenderVisibleElements
          proOptions={{ hideAttribution: false }}
        >
          <Background color="var(--board-grid)" gap={22} size={1} />
          <Controls showInteractive={false} position="bottom-left" fitViewOptions={{ padding: 0.18, maxZoom: 1 }} />
          {overview ? (
            <MiniMap
              ariaLabel="Schema overview"
              position="top-right"
              style={{ width: 128, height: 88 }}
              nodeColor="var(--board-minimap-node)"
              nodeStrokeColor="var(--board-edge)"
              bgColor="var(--panel)"
              maskColor="var(--board-minimap-mask)"
              maskStrokeColor="var(--accent)"
              pannable
              zoomable
            />
          ) : null}
        </ReactFlow>
      </div>
      {notes.length ? <div className="canvas-note">{notes.join(" ")}</div> : null}
    </div>
  );
}
