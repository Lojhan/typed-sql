import { type AnalysisTab, analysisId, analysisTitle } from "./analysis-tabs";
import { type InspectionTab, inspectionTarget } from "./explorer-model.js";

/** Framework-neutral counterpart of the docs playground's recursive editor layout. */
export type Edge = "center" | "left" | "right" | "top" | "bottom";
export type ToolTab = "@schema" | "@compare" | "@agent" | InspectionTab | AnalysisTab;
export interface Pane {
  kind: "pane";
  id: string;
  active: string;
  tabs: string[];
  bottom: "results" | "types" | "bindings" | "problems";
  bottomRatio: number;
  runId?: string;
}
export interface Split {
  kind: "split";
  id: string;
  axis: "horizontal" | "vertical";
  ratio: number;
  first: Layout;
  second: Layout;
}
export type Layout = Pane | Split;
export const FILE_MIME = "application/x-typed-sql-file";
export const toolTabs: Readonly<Record<Exclude<ToolTab, InspectionTab | AnalysisTab>, string>> = {
  "@schema": "Schema",
  "@compare": "Compare",
  "@agent": "Agent",
};
export const isTool = (tab: string): tab is ToolTab =>
  Object.hasOwn(toolTabs, tab) || inspectionTarget(tab) !== undefined || analysisId(tab) !== undefined;
export const title = (tab: string) =>
  analysisTitle(tab) ??
  inspectionTarget(tab)?.label ??
  (Object.hasOwn(toolTabs, tab) ? toolTabs[tab as keyof typeof toolTabs] : (tab.split("/").at(-1) ?? tab));
const id = () => crypto.randomUUID();
export function pane(tab = "@schema"): Pane {
  return { kind: "pane", id: id(), active: tab, tabs: tab ? [tab] : [], bottom: "results", bottomRatio: 0.36 };
}
export function panes(layout: Layout): Pane[] {
  return layout.kind === "pane" ? [layout] : [...panes(layout.first), ...panes(layout.second)];
}
export function changePane(layout: Layout, paneId: string, fn: (value: Pane) => Pane): Layout {
  return layout.kind === "pane"
    ? layout.id === paneId
      ? fn(layout)
      : layout
    : { ...layout, first: changePane(layout.first, paneId, fn), second: changePane(layout.second, paneId, fn) };
}
export function ratio(layout: Layout, splitId: string, value: number): Layout {
  return layout.kind === "pane"
    ? layout
    : {
        ...layout,
        ratio: layout.id === splitId ? Math.max(0.15, Math.min(0.85, value)) : layout.ratio,
        first: ratio(layout.first, splitId, value),
        second: ratio(layout.second, splitId, value),
      };
}
export function remove(layout: Layout, paneId: string): Layout | undefined {
  if (layout.kind === "pane") return layout.id === paneId ? undefined : layout;
  const first = remove(layout.first, paneId),
    second = remove(layout.second, paneId);
  return first && second ? { ...layout, first, second } : (first ?? second);
}
export function close(layout: Layout, paneId: string, tab: string): Layout {
  const next = changePane(layout, paneId, (value) => {
    const tabs = value.tabs.filter((item) => item !== tab);
    return {
      ...value,
      tabs,
      active: value.active === tab ? (tabs[Math.min(value.tabs.indexOf(tab), tabs.length - 1)] ?? "") : value.active,
    };
  });
  const current = panes(next).find((value) => value.id === paneId);
  return current && !current.tabs.length && panes(next).length > 1 ? (remove(next, paneId) ?? pane("")) : next;
}
export function open(layout: Layout, paneId: string, tab: string): Layout {
  return changePane(layout, paneId, (value) => ({
    ...value,
    active: tab,
    tabs: value.tabs.includes(tab) ? value.tabs : [...value.tabs, tab],
  }));
}
function replace(layout: Layout, paneId: string, value: Layout): Layout {
  return layout.kind === "pane"
    ? layout.id === paneId
      ? value
      : layout
    : { ...layout, first: replace(layout.first, paneId, value), second: replace(layout.second, paneId, value) };
}
export function drop(
  layout: Layout,
  targetId: string,
  tab: string,
  edge: Edge,
  sourceId?: string,
): { layout: Layout; active: string } {
  let next = structuredClone(layout);
  const target = panes(next).find((value) => value.id === targetId);
  if (!target) return { layout, active: panes(layout)[0]!.id };
  if (edge !== "center" && panes(next).length >= 8) return { layout, active: targetId };
  if (edge === "center") {
    next = open(next, targetId, tab);
    if (sourceId && sourceId !== targetId) next = close(next, sourceId, tab);
    return { layout: next, active: targetId };
  }
  const second = pane(tab);
  const before = edge === "left" || edge === "top";
  next = replace(next, targetId, {
    kind: "split",
    id: id(),
    axis: edge === "left" || edge === "right" ? "horizontal" : "vertical",
    ratio: 0.5,
    first: before ? second : target,
    second: before ? target : second,
  });
  // Splitting copies the view; buffers remain shared by file identity.
  return { layout: next, active: second.id };
}
export function validLayout(value: unknown, files: ReadonlySet<string>): Layout | undefined {
  let count = 0;
  const ids = new Set<string>();
  const parse = (input: unknown, depth: number): Layout | undefined => {
    if (!input || typeof input !== "object" || depth > 8) return;
    const data = input as Record<string, unknown>;
    if (typeof data.id !== "string" || ids.has(data.id)) return;
    ids.add(data.id);
    if (data.kind === "pane") {
      if (++count > 8 || !Array.isArray(data.tabs)) return;
      const tabs = [
        ...new Set(
          data.tabs.filter((tab): tab is string => typeof tab === "string" && (isTool(tab) || files.has(tab))),
        ),
      ].slice(0, 64);
      return {
        kind: "pane",
        id: data.id,
        tabs,
        active: typeof data.active === "string" && tabs.includes(data.active) ? data.active : (tabs[0] ?? ""),
        bottom: ["results", "types", "bindings", "problems"].includes(String(data.bottom))
          ? (data.bottom as Pane["bottom"])
          : "results",
        bottomRatio:
          typeof data.bottomRatio === "number" && Number.isFinite(data.bottomRatio)
            ? Math.max(0.15, Math.min(0.8, data.bottomRatio))
            : 0.36,
        ...(typeof data.runId === "string" ? { runId: data.runId } : {}),
      };
    }
    if (data.kind !== "split" || !["horizontal", "vertical"].includes(String(data.axis))) return;
    const first = parse(data.first, depth + 1),
      second = parse(data.second, depth + 1);
    if (!first || !second) return;
    return {
      kind: "split",
      id: data.id,
      axis: data.axis as Split["axis"],
      ratio:
        typeof data.ratio === "number" && Number.isFinite(data.ratio)
          ? Math.max(0.15, Math.min(0.85, data.ratio))
          : 0.5,
      first,
      second,
    };
  };
  return parse(value, 0);
}
export interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  file: boolean;
}
export function fileTree(files: readonly string[], folders: readonly string[] = []): TreeNode[] {
  const root: TreeNode = { name: "", path: "", children: [], file: false };
  for (const path of [...folders, ...files].sort()) {
    let current = root;
    const parts = path.split("/");
    for (const [position, name] of parts.entries()) {
      const childPath = parts.slice(0, position + 1).join("/");
      let child = current.children.find((item) => item.name === name);
      if (!child) {
        child = { name, path: childPath, children: [], file: position === parts.length - 1 && !folders.includes(path) };
        current.children.push(child);
      }
      current = child;
    }
  }
  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .toSorted((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name))
      .map((node) => ({ ...node, children: sort(node.children) }));
  return sort(root.children);
}
