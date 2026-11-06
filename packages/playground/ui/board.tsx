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
} from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { Board, Table } from "./types";
import "@xyflow/react/dist/style.css";

type TableNodeType = Node<{ table: Table; selectedTable: string | null }, "table">;
const TableNode = memo(function TableNode({ data }: NodeProps<TableNodeType>) {
  const table = data.table;
  return (
    <article className={`table-node ${data.selectedTable === table.id ? "is-selected" : ""}`}>
      <header>
        <span className="table-icon">▦</span>
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
  let componentY = 0;
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
    let bottom = componentY;
    for (const [depth, ids] of layers) {
      let y = componentY;
      for (const id of ids) {
        const item = board.tables.find((t) => t.id === id)!;
        result.set(id, { x: depth * 365, y });
        y += 118 + item.columns.length * 30;
      }
      bottom = Math.max(bottom, y);
    }
    componentY = bottom + 50;
  }
  return result;
}

export function SchemaBoard({
  board,
  selected,
  onSelect,
  search,
  identity,
}: {
  board: Board;
  selected: string | null;
  onSelect: (id: string) => void;
  search: string;
  identity: string;
}) {
  const [focus, setFocus] = useState(false);
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
  useEffect(() => {
    let saved: Record<string, { x: number; y: number }> = {};
    try {
      saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    } catch {
      /* Invalid local display state never affects schema. */
    }
    setNodes(
      visible.map((table) => ({
        id: table.id,
        type: "table",
        position: saved[table.id] ?? layout.get(table.id) ?? { x: 0, y: 0 },
        data: { table, selectedTable: selected },
      })),
    );
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
            stroke: selected === edge.source || selected === edge.target ? "#5c876b" : "#acb8a5",
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
  return (
    <div className="schema-canvas">
      <div className="canvas-toolbar">
        <span>
          <b>{visible.length}</b> of {board.tables.length} relations
        </span>
        <div>
          <button
            type="button"
            className={focus ? "active" : ""}
            onClick={() => setFocus((value) => !value)}
            disabled={!selected}
          >
            Focus neighbors
          </button>
          <button
            type="button"
            onClick={() => {
              localStorage.removeItem(storageKey);
              setNodes((current) =>
                current.map((node) => ({ ...node, position: layout.get(node.id) ?? node.position })),
              );
            }}
          >
            Reset layout
          </button>
        </div>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={changed}
        onNodeClick={(_, node) => onSelect(node.id)}
        onNodeDragStop={saveLayout}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.15}
        maxZoom={1.5}
        nodesConnectable={false}
        deleteKeyCode={null}
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: false }}
      >
        <Background color="#d9dfd5" gap={22} size={1} />
        <Controls showInteractive={false} />
        <MiniMap nodeColor="#e1e9dd" maskColor="rgba(248,250,246,.6)" pannable zoomable />
      </ReactFlow>
      {!board.capturedRelationships ? (
        <div className="canvas-note">
          Relationships were not captured in this snapshot. No edges have been inferred.
        </div>
      ) : null}
      {board.tables.length > 100 ? (
        <div className="canvas-note">Showing a bounded neighborhood. Search or focus a relation to explore more.</div>
      ) : null}
    </div>
  );
}
