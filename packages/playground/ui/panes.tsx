import { type DragEvent, type ReactNode, useRef, useState } from "react";
import { inspectionTarget } from "./explorer-model";
import { fileIcon, Icon } from "./icon";
import { type Edge, FILE_MIME, isTool, type Layout, type Pane, title } from "./layout";
export function Resize({
  axis,
  onChange,
  label,
}: {
  axis: "horizontal" | "vertical";
  onChange: (delta: number, size: number) => void;
  label: string;
}) {
  const element = useRef<HTMLHRElement>(null);
  return (
    <hr
      ref={element}
      className={`resize-handle ${axis}`}
      aria-valuenow={50}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      aria-label={label}
      aria-orientation={axis === "horizontal" ? "vertical" : "horizontal"}
      onKeyDown={(event) => {
        const direction = ["ArrowRight", "ArrowDown"].includes(event.key)
          ? 1
          : ["ArrowLeft", "ArrowUp"].includes(event.key)
            ? -1
            : 0;
        if (direction) {
          event.preventDefault();
          const parent = element.current?.parentElement?.getBoundingClientRect();
          onChange(direction * 20, axis === "horizontal" ? (parent?.width ?? 1000) : (parent?.height ?? 600));
        }
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        const start = axis === "horizontal" ? event.clientX : event.clientY;
        const parent = element.current?.parentElement?.getBoundingClientRect();
        const size = axis === "horizontal" ? (parent?.width ?? 1000) : (parent?.height ?? 600);
        let last = start;
        const move = (next: PointerEvent) => {
          const current = axis === "horizontal" ? next.clientX : next.clientY;
          onChange(current - last, size);
          last = current;
        };
        const stop = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", stop);
          document.body.classList.remove("is-resizing");
        };
        document.body.classList.add("is-resizing");
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop, { once: true });
      }}
    />
  );
}
interface Props {
  node: Layout;
  active: string;
  dirty: ReadonlySet<string>;
  onActivate: (id: string) => void;
  onOpen: (id: string, tab: string) => void;
  onClose: (id: string, tab: string) => void;
  onSplit: (id: string, edge: Edge) => void;
  onDrop: (id: string, tab: string, edge: Edge, source?: string) => void;
  onRatio: (id: string, delta: number, size: number) => void;
  render: (pane: Pane) => ReactNode;
}
export function PaneLayout(props: Props) {
  const { node } = props;
  const root = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState<Edge | undefined>();
  const [menu, setMenu] = useState(false);
  if (node.kind === "split")
    return (
      <div className={`pane-split ${node.axis}`}>
        <div style={{ flex: `${node.ratio} 1 0` }}>
          <PaneLayout {...props} node={node.first} />
        </div>
        <Resize
          axis={node.axis}
          label="Resize editor split"
          onChange={(delta, size) => props.onRatio(node.id, delta, size)}
        />
        <div style={{ flex: `${1 - node.ratio} 1 0` }}>
          <PaneLayout {...props} node={node.second} />
        </div>
      </div>
    );
  const drag = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes(FILE_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = root.current!.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width,
      y = (event.clientY - rect.top) / rect.height;
    const closest = Math.min(x, 1 - x, y, 1 - y);
    setEdge(
      closest > 0.25
        ? "center"
        : closest === x
          ? "left"
          : closest === 1 - x
            ? "right"
            : closest === y
              ? "top"
              : "bottom",
    );
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop target contains focusable tabs and an editor.
    <div
      ref={root}
      className={`editor-pane ${props.active === node.id ? "active-pane" : ""}`}
      onPointerDownCapture={() => props.onActivate(node.id)}
      onFocusCapture={() => props.onActivate(node.id)}
      onDragOver={drag}
      onDragLeave={(event) => {
        if (!root.current?.contains(event.relatedTarget as Node | null)) setEdge(undefined);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          const data = JSON.parse(event.dataTransfer.getData(FILE_MIME)) as { tab: string; source?: string };
          if (typeof data.tab === "string")
            props.onDrop(node.id, data.tab, edge ?? "center", event.altKey ? undefined : data.source);
        } catch {}
        setEdge(undefined);
      }}
    >
      <div className="pane-tabbar">
        <div className="pane-tabs" role="tablist" aria-label="Open workspace tabs">
          {node.tabs.map((tab) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: draggable wrapper has separate native tab and close buttons.
            <div
              className={`pane-tab ${node.active === tab ? "selected" : ""}`}
              key={tab}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(FILE_MIME, JSON.stringify({ tab, source: node.id }));
                event.dataTransfer.effectAllowed = "copyMove";
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={node.active === tab}
                title={isTool(tab) ? title(tab) : tab}
                onClick={() => props.onOpen(node.id, tab)}
              >
                <Icon
                  name={
                    inspectionTarget(tab)?.kind === "migration"
                      ? "migration"
                      : inspectionTarget(tab)?.kind === "object"
                        ? "database"
                        : tab === "@schema"
                          ? "schema"
                          : tab === "@compare"
                            ? "compare"
                            : tab === "@agent"
                              ? "agent"
                              : fileIcon(tab)
                  }
                />
                {title(tab)}
                {props.dirty.has(tab) ? <span className="dirty-mark">●</span> : null}
              </button>
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${title(tab)}`}
                onClick={() => props.onClose(node.id, tab)}
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
        <div className="pane-actions">
          <button
            type="button"
            className="icon-button"
            title="Split editor"
            aria-label="Split editor"
            onClick={() => setMenu((value) => !value)}
          >
            <Icon name="split" />
          </button>
          {menu ? (
            <div className="split-menu" role="menu">
              {(["left", "right", "top", "bottom"] as const).map((direction) => (
                <button
                  type="button"
                  role="menuitem"
                  key={direction}
                  onClick={() => {
                    props.onSplit(node.id, direction);
                    setMenu(false);
                  }}
                >
                  Split {direction}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className="pane-body" role="tabpanel">
        {props.render(node)}
      </div>
      {edge ? (
        <div className={`drop-preview ${edge}`}>
          <span>{edge === "center" ? "Open tab" : `Split ${edge}`}</span>
        </div>
      ) : null}
    </div>
  );
}
