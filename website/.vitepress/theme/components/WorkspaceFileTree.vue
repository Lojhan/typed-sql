<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { EDITOR_FILE_MIME, readEditorDrop } from "../playground/editor-layout.js";
import {
  entryPathError,
  TREE_ENTRY_MIME,
  type TreeDragEntry,
  treeMoveDestination,
  workspaceFolders,
} from "../playground/file-operations.js";
import { WORKSPACE_LIMITS } from "../playground/workspace.js";
import { WORKSPACE_CONFIG_NAME, WORKSPACE_CONFIG_PATH } from "../playground/workspace-ui.js";
import type { TreeNameEdit } from "./FileTreeNameInput.vue";
import FileTreeNode, { type FileTreeEntry } from "./FileTreeNode.vue";
import ScrollArea from "./ScrollArea.vue";

const props = defineProps<{
  files: readonly string[];
  folders: readonly string[];
  activeFile: string;
  problems: readonly string[];
}>();
const emit = defineEmits<{
  select: [path: string];
  create: [path: string];
  createFolder: [path: string];
  rename: [from: string, to: string, folder: boolean];
  delete: [path: string, folder: boolean];
}>();
const tree = ref<HTMLElement>();
const menuElement = ref<HTMLElement>();
const dragged = ref<TreeDragEntry>();
const dropFolder = ref<string>();
const moveError = ref("");
let expandTimer: ReturnType<typeof setTimeout> | undefined;
const cancelButton = ref<HTMLButtonElement>();
const menu = ref<{ entry?: FileTreeEntry; x: number; y: number }>();
const editing = ref<{ action: "file" | "folder" | "rename" | "delete"; entry?: FileTreeEntry }>();
const path = ref("");
const error = ref("");
let returnFocus: HTMLElement | undefined;
const userFiles = computed(() =>
  Object.fromEntries(props.files.filter((file) => file !== WORKSPACE_CONFIG_PATH).map((file) => [file, ""])),
);
const entries = computed(() => {
  const root: FileTreeEntry[] = [];
  for (const file of [
    ...workspaceFolders(
      props.files.filter((file) => file !== WORKSPACE_CONFIG_PATH),
      props.folders,
    ),
    ...props.files,
  ]) {
    if (file === WORKSPACE_CONFIG_PATH) {
      root.push({ name: WORKSPACE_CONFIG_NAME, path: file, readonly: true });
      continue;
    }
    let children = root;
    const parts = file.split("/");
    parts.forEach((name, index) => {
      const folder = index < parts.length - 1 || !props.files.includes(file);
      let entry = children.find((node) => node.name === name);
      if (!entry) {
        entry = { name, path: parts.slice(0, index + 1).join("/"), ...(folder ? { children: [] } : {}) };
        children.push(entry);
      }
      if (entry.children) children = entry.children;
    });
  }
  const sort = (nodes: FileTreeEntry[]) => {
    nodes.sort((a, b) => Number(Boolean(b.children)) - Number(Boolean(a.children)) || a.name.localeCompare(b.name));
    for (const node of nodes) if (node.children) sort(node.children);
  };
  sort(root);
  const edit = editing.value;
  if (edit && (edit.action === "file" || edit.action === "folder")) {
    const find = (nodes: FileTreeEntry[], path: string): FileTreeEntry | undefined => {
      for (const node of nodes) {
        if (node.path === path) return node;
        const child = node.children && find(node.children, path);
        if (child) return child;
      }
    };
    const parent = edit.entry?.path ? find(root, edit.entry.path)?.children : root;
    parent?.unshift({
      name: "",
      path: "__new_entry__",
      draft: true,
      ...(edit.action === "folder" ? { children: [] } : {}),
    });
  }
  return root;
});
const actions = computed(() => {
  const entry = menu.value?.entry;
  if (entry?.readonly) return [];
  return [
    ...(!entry || entry.children
      ? [
          { id: "file", label: "New File…" },
          { id: "folder", label: "New Folder…" },
        ]
      : []),
    ...(entry
      ? [
          { id: "rename", label: "Rename…" },
          { id: "delete", label: "Delete…" },
        ]
      : []),
  ] as { id: "file" | "folder" | "rename" | "delete"; label: string }[];
});
async function context(event: MouseEvent, entry?: FileTreeEntry) {
  event.preventDefault();
  event.stopPropagation();
  if (entry?.draft) return;
  editing.value = undefined;
  returnFocus = event.currentTarget as HTMLElement;
  if (entry?.readonly) {
    menu.value = undefined;
    return;
  }
  if (entry && !entry.children) emit("select", entry.path);
  menu.value = { entry, x: event.clientX, y: event.clientY };
  await nextTick();
  const rect = menuElement.value?.getBoundingClientRect();
  if (rect && menu.value) {
    menu.value.x = Math.max(4, Math.min(menu.value.x, window.innerWidth - rect.width - 4));
    menu.value.y = Math.max(4, Math.min(menu.value.y, window.innerHeight - rect.height - 4));
  }
  menuElement.value?.querySelector<HTMLButtonElement>("button")?.focus();
}
function close() {
  menu.value = undefined;
  editing.value = undefined;
  (returnFocus?.isConnected ? returnFocus : tree.value)?.focus();
}
async function action(id: "file" | "folder" | "rename" | "delete", entry = menu.value?.entry) {
  if (!menu.value) returnFocus = document.activeElement as HTMLElement;
  menu.value = undefined;
  editing.value = { action: id, entry };
  error.value = "";
  path.value = id === "rename" ? entry!.name : "";
  if (entry?.children && (id === "file" || id === "folder")) {
    const summary = [...tree.value!.querySelectorAll<HTMLElement>("summary")].find((node) => node.title === entry.path);
    if (summary?.parentElement instanceof HTMLDetailsElement) summary.parentElement.open = true;
  }
  await nextTick();
  if (id === "delete") cancelButton.value?.focus();
}
function submit() {
  const edit = editing.value;
  if (!edit) return;
  if (edit.action === "delete") {
    emit("delete", edit.entry!.path, Boolean(edit.entry!.children));
    close();
    return;
  }
  const parent =
    edit.action === "rename" ? edit.entry!.path.split("/").slice(0, -1).join("/") : (edit.entry?.path ?? "");
  const name = [parent, path.value.trim()].filter(Boolean).join("/");
  error.value = !path.value.trim()
    ? "Enter a name."
    : (entryPathError(
        userFiles.value,
        props.folders,
        name,
        edit.action === "folder" || (Boolean(edit.entry?.children) && edit.action === "rename"),
        edit.action === "rename" ? edit.entry?.path : undefined,
      ) ?? "");
  if (!error.value && edit.action === "file" && Object.keys(userFiles.value).length >= WORKSPACE_LIMITS.files)
    error.value = "The playground supports up to 40 files.";
  if (error.value) return;
  if (edit.action === "rename") emit("rename", edit.entry!.path, name, Boolean(edit.entry!.children));
  else if (edit.action === "folder") emit("createFolder", name);
  else emit("create", name);
  close();
}
const inlineEdit = computed<TreeNameEdit | undefined>(() => {
  const edit = editing.value;
  if (!edit || edit.action === "delete") return;
  return {
    target: edit.action === "rename" ? edit.entry?.path : undefined,
    name: path.value,
    folder: edit.action === "folder" || (edit.action === "rename" && Boolean(edit.entry?.children)),
    label: edit.action === "rename" ? "Rename name" : edit.action === "folder" ? "New folder name" : "New file name",
    error: error.value,
    change: (name) => {
      path.value = name;
      error.value = "";
    },
    submit,
    cancel: close,
  };
});

function menuKey(event: KeyboardEvent) {
  if (event.key === "Escape" || event.key === "Tab") {
    if (event.key === "Escape") event.preventDefault();
    close();
    return;
  }
  const buttons = [...menuElement.value!.querySelectorAll<HTMLButtonElement>("button")];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "ArrowDown"
      ? (index + 1) % buttons.length
      : event.key === "ArrowUp"
        ? (index - 1 + buttons.length) % buttons.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : -1;
  if (next >= 0) {
    event.preventDefault();
    buttons[next]?.focus();
  }
}
function treeKey(event: KeyboardEvent) {
  if ((event.target as HTMLElement).closest("form, input")) return;
  const row = (event.target as HTMLElement).closest<HTMLElement>(".pg-file-row");
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    event.preventDefault();
    const element = row ?? tree.value!;
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.x + 24, clientY: rect.bottom }),
    );
    return;
  }
  const rows = [...tree.value!.querySelectorAll<HTMLElement>(".pg-file-row")].filter(
    (element) => element.getClientRects().length,
  );
  const index = row ? rows.indexOf(row) : -1;
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : event.key === "ArrowDown"
            ? Math.min(index + 1, rows.length - 1)
            : Math.max(0, index - 1);
    rows[next]?.focus();
  } else if (row && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    const details = row.parentElement;
    if (
      row.tagName === "SUMMARY" &&
      details instanceof HTMLDetailsElement &&
      (event.key === "ArrowRight" ? !details.open : details.open)
    )
      details.open = event.key === "ArrowRight";
    else if (event.key === "ArrowRight" && row.tagName === "SUMMARY") rows[index + 1]?.focus();
    else if (event.key === "ArrowLeft")
      row.closest("ul")?.parentElement?.querySelector<HTMLElement>(":scope > summary")?.focus();
  }
}

function finishDrag() {
  dragged.value = undefined;
  dropFolder.value = undefined;
  clearTimeout(expandTimer);
}
function startDrag(event: DragEvent) {
  const row = (event.target as HTMLElement).closest<HTMLElement>("[data-tree-path]");
  const path = row?.dataset.treePath;
  if (!path || path === "__new_entry__" || row?.dataset.treeReadonly || !event.dataTransfer) return;
  dragged.value = { path, folder: row?.dataset.treeFolder === "true" };
  event.dataTransfer.setData(TREE_ENTRY_MIME, JSON.stringify(dragged.value));
  event.dataTransfer.effectAllowed = dragged.value.folder ? "move" : "copyMove";
  menu.value = undefined;
  moveError.value = "";
}
function dropParent(event: DragEvent): string {
  const row = (event.target as HTMLElement).closest<HTMLElement>("[data-tree-path]");
  const path = row?.dataset.treePath;
  if (row?.dataset.treeReadonly || path === "__new_entry__") return "";
  return row?.dataset.treeFolder ? path! : (path?.split("/").slice(0, -1).join("/") ?? "");
}
function dragOver(event: DragEvent) {
  if (!event.dataTransfer?.types.some((type) => type === TREE_ENTRY_MIME || type === EDITOR_FILE_MIME)) return;
  event.preventDefault();
  event.stopPropagation();
  const row = (event.target as HTMLElement).closest<HTMLElement>("[data-tree-path]");
  const parent = dropParent(event);
  const destination = dragged.value
    ? treeMoveDestination(userFiles.value, props.folders, dragged.value, parent)
    : undefined;
  const allowed = !destination || Boolean(destination.path);
  event.dataTransfer.dropEffect = allowed ? "move" : "none";
  const target = allowed ? parent : undefined;
  if (dropFolder.value !== target) {
    dropFolder.value = target;
    clearTimeout(expandTimer);
    if (target && row?.tagName === "SUMMARY")
      expandTimer = setTimeout(() => {
        if (row.parentElement instanceof HTMLDetailsElement) row.parentElement.open = true;
      }, 600);
  }
}
function drop(event: DragEvent) {
  if (!event.dataTransfer?.types.some((type) => type === TREE_ENTRY_MIME || type === EDITOR_FILE_MIME)) return;
  event.preventDefault();
  event.stopPropagation();
  const parent = dropParent(event);
  moveError.value = "";
  let entry = dragged.value;
  if (!entry) {
    try {
      const value = JSON.parse(event.dataTransfer.getData(TREE_ENTRY_MIME) || "null");
      if (value && typeof value.path === "string" && typeof value.folder === "boolean") entry = value;
    } catch {
      /* A tab drag uses the editor payload instead. */
    }
    const file = readEditorDrop(event)?.file;
    if (!entry && file) entry = { path: file, folder: false };
  }
  if (entry) {
    const destination = treeMoveDestination(userFiles.value, props.folders, entry, parent);
    if (destination.error) moveError.value = destination.error;
    else if (destination.path) emit("rename", entry.path, destination.path, entry.folder);
  }
  finishDrag();
}
function leaveDrag(event: DragEvent) {
  if (!tree.value?.contains(event.relatedTarget as Node | null)) {
    dropFolder.value = undefined;
    clearTimeout(expandTimer);
  }
}

function outside(event: PointerEvent) {
  if (!menuElement.value?.contains(event.target as Node)) menu.value = undefined;
}
function dismiss() {
  menu.value = undefined;
}
watch(
  () => props.files,
  () => {
    menu.value = undefined;
  },
);
onMounted(() => {
  window.addEventListener("pointerdown", outside);
  window.addEventListener("resize", dismiss);
  window.addEventListener("blur", dismiss);
  window.addEventListener("dragend", finishDrag);
});
onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", outside);
  window.removeEventListener("resize", dismiss);
  window.removeEventListener("blur", dismiss);
  window.removeEventListener("dragend", finishDrag);
  clearTimeout(expandTimer);
});
</script>

<template>
  <nav ref="tree" class="pg-file-tree" :class="{ 'is-drop-root': dropFolder === '' }" @dragstart="startDrag" @dragover="dragOver" @drop="drop" @dragleave="leaveDrag" aria-label="Workspace files" tabindex="0" @contextmenu.self="context($event)" @keydown.esc="close" @keydown="treeKey">
    <form v-if="editing?.action === 'delete'" class="pg-new-file" @submit.prevent="submit" @keydown.esc.stop.prevent="close">
      <p class="pg-delete-message">Delete {{ editing.entry?.children ? 'folder' : 'file' }} “{{ editing.entry?.name }}”{{ editing.entry?.children ? ' and its contents' : '' }}? This cannot be undone.</p>
      <div><button type="submit" class="is-destructive">Delete</button><button ref="cancelButton" type="button" @click="close">Cancel</button></div>
    </form>
    <ScrollArea class="pg-file-list" label="File tree" @contextmenu="context($event)" @scroll.capture="dismiss"><ul class="pg-file-entries"><FileTreeNode v-for="entry in entries" :key="entry.path" :entry="entry" :edit="inlineEdit" :drop-folder="dropFolder" :active-file="activeFile" :problems="problems" @select="emit('select', $event)" @context="context" @rename="action('rename', $event)" @delete="action('delete', $event)" /></ul><p v-if="!Object.keys(userFiles).length && !folders.length" class="pg-tree-empty">Right-click to add a file or folder.</p></ScrollArea>
    <div v-if="dropFolder === ''" class="pg-tree-root-drop" aria-hidden="true">Move to project root</div>
    <p v-if="moveError" class="pg-tree-move-error" role="alert">{{ moveError }}<button type="button" aria-label="Dismiss move error" @click="moveError = ''">×</button></p>
    <Teleport to="body"><div v-if="menu" ref="menuElement" class="pg-tree-menu" role="menu" aria-label="File actions" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" @keydown="menuKey" @contextmenu.prevent><button v-for="item in actions" :key="item.id" role="menuitem" type="button" :class="{ 'is-destructive': item.id === 'delete' }" @click="action(item.id)">{{ item.label }}</button></div></Teleport>
  </nav>
</template>
