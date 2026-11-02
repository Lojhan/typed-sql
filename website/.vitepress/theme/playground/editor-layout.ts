export type DropEdge = "center" | "left" | "right" | "top" | "bottom";
export interface EditorPane {
  kind: "pane";
  id: string;
  file: string;
  tabs: string[];
  cursors: Record<string, number>;
}
export interface EditorSplit {
  kind: "split";
  id: string;
  axis: "horizontal" | "vertical";
  ratio: number;
  first: EditorLayout;
  second: EditorLayout;
}
export type EditorLayout = EditorPane | EditorSplit;
let sequence = 0;
export function createPane(file: string, tabs = [file]): EditorPane {
  return { kind: "pane", id: `pane-${++sequence}`, file, cursors: {}, tabs: [...new Set([...tabs, file])] };
}
export function editorPanes(layout: EditorLayout): EditorPane[] {
  return layout.kind === "pane" ? [layout] : [...editorPanes(layout.first), ...editorPanes(layout.second)];
}
export function openInPane(pane: EditorPane, file: string) {
  if (!pane.tabs.includes(file)) pane.tabs.push(file);
  pane.file = file;
}
export function removePane(layout: EditorLayout, id: string): EditorLayout | undefined {
  if (layout.kind === "pane") return layout.id === id ? undefined : layout;
  const first = removePane(layout.first, id);
  const second = removePane(layout.second, id);
  return first && second ? { ...layout, first, second } : (first ?? second);
}
function replacePane(layout: EditorLayout, id: string, replacement: EditorLayout): EditorLayout {
  if (layout.kind === "pane") return layout.id === id ? replacement : layout;
  return {
    ...layout,
    first: replacePane(layout.first, id, replacement),
    second: replacePane(layout.second, id, replacement),
  };
}
export function dropEditorFile(
  layout: EditorLayout,
  targetId: string,
  file: string,
  edge: DropEdge,
  sourceId?: string,
  beforeFile?: string,
): { layout: EditorLayout; active: string } {
  const target = editorPanes(layout).find((pane) => pane.id === targetId);
  if (!target) return { layout, active: editorPanes(layout)[0]!.id };
  if (edge !== "center" && editorPanes(layout).length >= 8) return { layout, active: target.id };
  const source = editorPanes(layout).find((pane) => pane.id === sourceId);
  // Splitting a pane with its sole tab intentionally keeps the original view open.
  const move = source && (source.id !== targetId || edge === "center" || source.tabs.length > 1);
  if (move && !(source === target && beforeFile === file)) {
    source.tabs = source.tabs.filter((tab) => tab !== file);
    if (source.file === file && source.tabs.length) source.file = source.tabs[0]!;
  }
  if (edge === "center") {
    if (beforeFile && beforeFile !== file) {
      target.tabs = target.tabs.filter((tab) => tab !== file);
      const index = target.tabs.indexOf(beforeFile);
      target.tabs.splice(index < 0 ? target.tabs.length : index, 0, file);
      target.file = file;
    } else openInPane(target, file);
    if (source && source !== target && !source.tabs.length) layout = removePane(layout, source.id)!;
    return { layout, active: target.id };
  }
  const pane = createPane(file);
  const before = edge === "left" || edge === "top";
  layout = replacePane(layout, targetId, {
    kind: "split",
    id: `split-${++sequence}`,
    axis: edge === "left" || edge === "right" ? "horizontal" : "vertical",
    ratio: 0.5,
    first: before ? pane : target,
    second: before ? target : pane,
  });
  if (source && source !== target && !source.tabs.length) layout = removePane(layout, source.id)!;
  return { layout, active: pane.id };
}
export function closeEditorFile(layout: EditorLayout, paneId: string, file: string): EditorLayout {
  const pane = editorPanes(layout).find((item) => item.id === paneId);
  if (!pane || !pane.tabs.includes(file)) return layout;
  const index = pane.tabs.indexOf(file);
  pane.tabs.splice(index, 1);
  if (pane.file === file) pane.file = pane.tabs[Math.min(index, pane.tabs.length - 1)] ?? "";
  if (!pane.tabs.length && editorPanes(layout).length > 1) return removePane(layout, paneId)!;
  return layout;
}
export function isCloseFileShortcut(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">,
): boolean {
  return (
    !event.isComposing &&
    !event.shiftKey &&
    event.metaKey !== event.ctrlKey &&
    (event.code === "KeyW" || event.key.toLowerCase() === "w") &&
    (!event.altKey || event.ctrlKey)
  );
}
export const EDITOR_FILE_MIME = "application/x-typed-sql-file";
export function dragEditorFile(event: DragEvent, file: string, pane?: string) {
  if (!event.dataTransfer) return;
  event.dataTransfer.setData(EDITOR_FILE_MIME, JSON.stringify({ file, pane }));
  event.dataTransfer.effectAllowed = "copyMove";
}
export function readEditorDrop(event: DragEvent): { file: string; pane?: string } | undefined {
  try {
    const value = JSON.parse(event.dataTransfer?.getData(EDITOR_FILE_MIME) ?? "");
    return value && typeof value.file === "string" && (value.pane === undefined || typeof value.pane === "string")
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
