<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { type DropEdge, EDITOR_FILE_MIME, type EditorLayout, readEditorDrop } from "../playground/editor-layout.js";
import type { EditorAction, EditorResponse } from "../playground/editor-protocol.js";
import type { PlaygroundDialect } from "../playground/playground.js";
import type { WorkspaceAnalysis } from "../playground/semantic-service.js";
import { WORKSPACE_CONFIG_NAME, WORKSPACE_CONFIG_PATH } from "../playground/workspace-ui.js";
import CodeEditor, { type CodeEditorHandle } from "./CodeEditor.vue";
import PanelResizeHandle from "./PanelResizeHandle.vue";
import WorkspaceTabs from "./WorkspaceTabs.vue";

const props = defineProps<{
  node: EditorLayout;
  active: string;
  files: Record<string, string>;
  dialect: PlaygroundDialect;
  config: string;
  analysis?: WorkspaceAnalysis;
  busy: boolean;
  multiple: boolean;
  interact: (file: string, request: EditorAction) => Promise<EditorResponse>;
}>();
const emit = defineEmits<{
  focusPane: [id: string];
  selectFile: [id: string, file: string];
  edit: [file: string, source: string];
  inspect: [id: string, position: number];
  definition: [id: string, file: string, position: number];
  dropFile: [id: string, file: string, edge: DropEdge, source?: string, before?: string];
  closePane: [id: string];
  closeFile: [id: string, file: string];
}>();
const root = ref<HTMLElement>();
const editor = ref<CodeEditorHandle>();
interface LayoutHandle {
  focusRange(id: string, from: number, to: number): void;
  measure(): void;
}
const first = ref<LayoutHandle>();
const second = ref<LayoutHandle>();
const size = ref(600);
const dropEdge = ref<DropEdge>();
let observer: ResizeObserver | undefined;
const readonly = computed(() => props.node.kind === "pane" && props.node.file === WORKSPACE_CONFIG_PATH);
const source = computed(() =>
  props.node.kind === "pane" ? (readonly.value ? props.config : (props.files[props.node.file] ?? "")) : "",
);
const tabs = computed(() =>
  props.node.kind === "pane"
    ? props.node.tabs
        .filter((file) => file in props.files || file === WORKSPACE_CONFIG_PATH)
        .map((file) => ({
          value: file,
          label: file === WORKSPACE_CONFIG_PATH ? WORKSPACE_CONFIG_NAME : file.split("/").pop()!,
          title: file,
          icon: file.endsWith(".sql") ? "SQL" : "TS",
          iconTone: file.endsWith(".sql") ? ("sql" as const) : ("type" as const),
          attention: props.analysis?.problems.some((problem) => problem.file === file),
        }))
    : [],
);
const diagnostics = computed(() =>
  !props.busy && props.node.kind === "pane"
    ? (props.analysis?.problems.filter((problem) => props.node.kind === "pane" && problem.file === props.node.file) ??
      [])
    : [],
);
function dragOver(event: DragEvent) {
  if (props.node.kind !== "pane" || !event.dataTransfer?.types.includes(EDITOR_FILE_MIME)) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = "copy";
  const rect = root.value!.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  const nearest = Math.min(x, 1 - x, y, 1 - y);
  dropEdge.value =
    nearest > 0.25 ? "center" : nearest === x ? "left" : nearest === 1 - x ? "right" : nearest === y ? "top" : "bottom";
}
function drop(event: DragEvent) {
  const data = readEditorDrop(event);
  if (!data || props.node.kind !== "pane") return;
  event.preventDefault();
  event.stopPropagation();
  emit("dropFile", props.node.id, data.file, dropEdge.value ?? "center", data.pane);
  dropEdge.value = undefined;
}
function leave(event: DragEvent) {
  if (!root.value?.contains(event.relatedTarget as Node | null)) dropEdge.value = undefined;
}
function focusRange(id: string, from: number, to: number) {
  if (props.node.kind === "pane") {
    if (props.node.id === id) editor.value?.focusRange(from, to);
  } else {
    first.value?.focusRange(id, from, to);
    second.value?.focusRange(id, from, to);
  }
}
function measure() {
  editor.value?.measure();
  first.value?.measure();
  second.value?.measure();
}
onMounted(() => {
  observer = new ResizeObserver(() => {
    const rect = root.value?.getBoundingClientRect();
    if (rect && props.node.kind === "split") size.value = props.node.axis === "horizontal" ? rect.width : rect.height;
    measure();
  });
  if (root.value) observer.observe(root.value);
});
watch(root, (element) => {
  observer?.disconnect();
  if (element) observer?.observe(element);
});
onBeforeUnmount(() => observer?.disconnect());
defineExpose({ focusRange, measure });
</script>

<template>
  <div v-if="node.kind === 'split'" ref="root" class="pg-editor-split" :class="node.axis">
    <EditorPaneLayout ref="first" :node="node.first" :active="active" :files="files" :dialect="dialect" :config="config" :analysis="analysis" :busy="busy" :multiple="multiple" :interact="interact" :style="{ flex: `${node.ratio} 1 0` }" @focus-pane="(...args) => emit('focusPane', ...args)" @select-file="(...args) => emit('selectFile', ...args)" @edit="(...args) => emit('edit', ...args)" @inspect="(...args) => emit('inspect', ...args)" @definition="(...args) => emit('definition', ...args)" @drop-file="(...args) => emit('dropFile', ...args)" @close-pane="emit('closePane', $event)" @close-file="(...args) => emit('closeFile', ...args)" />
    <PanelResizeHandle :model-value="node.ratio * size" :min="size * .15" :max="size * .85" :orientation="node.axis === 'horizontal' ? 'vertical' : 'horizontal'" label="Resize editor split" @update:model-value="node.ratio = $event / size" />
    <EditorPaneLayout ref="second" :node="node.second" :active="active" :files="files" :dialect="dialect" :config="config" :analysis="analysis" :busy="busy" :multiple="multiple" :interact="interact" :style="{ flex: `${1 - node.ratio} 1 0` }" @focus-pane="(...args) => emit('focusPane', ...args)" @select-file="(...args) => emit('selectFile', ...args)" @edit="(...args) => emit('edit', ...args)" @inspect="(...args) => emit('inspect', ...args)" @definition="(...args) => emit('definition', ...args)" @drop-file="(...args) => emit('dropFile', ...args)" @close-pane="emit('closePane', $event)" @close-file="(...args) => emit('closeFile', ...args)" />
  </div>
  <div v-else ref="root" class="pg-editor-pane pg-source" :class="{ 'is-active-pane': node.id === active }" @focusin="emit('focusPane', node.id)" @pointerdown.capture="emit('focusPane', node.id)" @dragover="dragOver" @dragleave="leave" @drop="drop">
    <div class="pg-pane-trail">
      <WorkspaceTabs :model-value="node.file" :pane-id="node.id" :items="tabs" :id-prefix="node.id" :panel-id="`${node.id}-editor`" aria-label="Editor files" @update:model-value="emit('selectFile', node.id, $event)" @close-file="emit('closeFile', node.id, $event)" @drop-file="(file, source, before) => { dropEdge = undefined; emit('dropFile', node.id, file, 'center', source, before); }" />
      <button v-if="multiple" type="button" class="pg-close-pane" aria-label="Close editor pane" title="Close editor pane" @click="emit('closePane', node.id)">×</button>
    </div>
    <div :id="`${node.id}-editor`" class="pg-editor-content" role="tabpanel" :aria-labelledby="`${node.id}-${node.file}`">
      <CodeEditor v-if="node.file" :key="`${dialect}:${node.file}`" ref="editor" :model-value="source" :cursor-position="node.cursors[node.file] ?? 0" :readonly="readonly" :language="node.file.endsWith('.sql') ? 'sql' : 'typescript'" :sql-dialect="dialect" :aria-label="`${readonly ? 'View' : 'Edit'} ${node.file}`" :interact="readonly ? undefined : request => interact(node.file, request)" :diagnostics="diagnostics" :hovers="busy ? [] : analysis?.hovers[node.file] ?? []" :invalid="diagnostics.length > 0" @update:model-value="emit('edit', node.file, $event)" @inspect="node.cursors[node.file] = $event; emit('inspect', node.id, $event)" @definition="emit('definition', node.id, node.file, $event)" />
      <div v-if="!node.file" class="pg-empty">Open a file from the project tree.</div>
    </div>
    <div v-if="dropEdge" class="pg-drop-preview" :class="dropEdge" aria-hidden="true"><span>{{ dropEdge === 'center' ? 'Open in this pane' : `Split ${dropEdge}` }}</span></div>
  </div>
</template>

<style scoped>
.pg-editor-split { display: flex; min-width: 0; min-height: 0; overflow: hidden; }
.pg-editor-split.vertical { flex-direction: column; }
.pg-editor-pane { position: relative; min-width: 0; min-height: 0; flex: 1; }
.pg-pane-trail { display: flex; min-width: 0; height: 42px; border-bottom: 1px solid var(--vp-c-divider); background: var(--ts-editor-panel); }
.pg-pane-trail .workspace-tabs { flex: 1; min-width: 0; border-bottom: 0; }
.pg-close-pane { width: 28px; flex-shrink: 0; color: var(--vp-c-text-3); font: 18px/1 var(--vp-font-family-mono); }
.pg-close-pane:hover { color: var(--vp-c-text-1); }
.pg-editor-content { flex: 1; min-height: 0; overflow: hidden; }
.pg-editor-pane:not(.is-active-pane) .pg-pane-trail { opacity: .7; }
.pg-drop-preview { pointer-events: none; position: absolute; z-index: 10; inset: 43px 0 0; border: 1px solid var(--ts-c-type); background: color-mix(in srgb, var(--ts-c-type) 16%, transparent); display: grid; place-items: center; }
.pg-drop-preview.left { right: 50%; }.pg-drop-preview.right { left: 50%; }.pg-drop-preview.top { bottom: 50%; }.pg-drop-preview.bottom { top: 50%; }
.pg-drop-preview span { padding: 6px 10px; background: var(--ts-editor-panel); color: var(--vp-c-text-1); font: 11px var(--vp-font-family-mono); }
</style>
