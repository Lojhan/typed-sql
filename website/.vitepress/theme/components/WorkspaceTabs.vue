<script setup lang="ts" generic="Value extends string">
import { ref } from "vue";
import { dragEditorFile, EDITOR_FILE_MIME, readEditorDrop } from "../playground/editor-layout.js";
import ScrollArea from "./ScrollArea.vue";

const props = defineProps<{
  paneId?: string;
  modelValue: Value;
  items: readonly {
    value: Value;
    label: string;
    title?: string;
    icon?: string;
    iconTone?: "type" | "sql";
    attention?: boolean;
  }[];
  idPrefix: string;
  panelId: string;
  ariaLabel: string;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: Value];
  closeFile: [file: Value];
  dropFile: [file: string, source: string | undefined, before: string];
}>();
function dropTab(event: DragEvent, before: string) {
  if (!props.paneId) return;
  const data = readEditorDrop(event);
  if (!data) return;
  event.preventDefault();
  event.stopPropagation();
  emit("dropFile", data.file, data.pane, before);
}
const root = ref<HTMLElement>();

function navigate(event: KeyboardEvent, index: number) {
  let next: number;
  switch (event.key) {
    case "ArrowRight":
      next = (index + 1) % props.items.length;
      break;
    case "ArrowLeft":
      next = (index - 1 + props.items.length) % props.items.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = props.items.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  const item = props.items[next];
  if (!item) return;
  emit("update:modelValue", item.value);
  root.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
}
</script>

<template>
  <ScrollArea class="workspace-tabs" :label="ariaLabel" fill><div ref="root" class="workspace-tabs__list" role="tablist" :aria-label="ariaLabel">
    <div v-for="(item, index) in items" :key="item.value" class="workspace-tabs__item">
    <button
      :id="`${idPrefix}-${item.value}`"
      :draggable="!!paneId"
      @dragstart="paneId && dragEditorFile($event, item.value, paneId)"
      @dragover="event => { if (paneId && event.dataTransfer?.types.includes(EDITOR_FILE_MIME)) { event.preventDefault(); event.stopPropagation(); } }"
      @drop="dropTab($event, item.value)"
      type="button"
      role="tab"
      :aria-selected="modelValue === item.value"
      :aria-controls="panelId"
      :title="item.title ?? item.label"
      :tabindex="modelValue === item.value ? 0 : -1"
      @click="emit('update:modelValue', item.value)"
      @keydown="navigate($event, index)"
    >
      <span class="workspace-tabs__label">
        <span v-if="item.icon" class="workspace-tabs__icon" :class="`workspace-tabs__icon--${item.iconTone ?? 'type'}`" aria-hidden="true">{{ item.icon }}</span>
        <span>{{ item.label }}</span>
      </span>
      <span v-if="item.attention" class="workspace-tabs__attention" aria-label="Has problems" />
    </button>
    <button v-if="paneId" class="workspace-tabs__close" type="button" :aria-label="`Close ${item.label}`" title="Close file (Cmd+W / Ctrl+W; Ctrl+Alt+W fallback)" @click.stop="emit('closeFile', item.value)">×</button>
    </div>
  </div></ScrollArea>
</template>

<style scoped>
.workspace-tabs {
  height: 42px;
  flex-shrink: 0;
  box-sizing: border-box;
  background: var(--ts-editor-panel);
  border-bottom: 1px solid var(--vp-c-divider);
}

.workspace-tabs__list { display: flex; height: 100%; min-width: max-content; }

.workspace-tabs__item { display: flex; position: relative; height: 100%; }
.workspace-tabs__item:has(.workspace-tabs__close) > [role="tab"] { padding-right: 30px; }
.workspace-tabs button.workspace-tabs__close { position: absolute; right: 4px; top: 0; height: 100%; width: 22px; padding: 0; border: 0; background: transparent; opacity: 0; font-size: 16px; }
.workspace-tabs__item:hover .workspace-tabs__close, .workspace-tabs__item:focus-within .workspace-tabs__close { opacity: 1; }
.workspace-tabs button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  flex-shrink: 0;
  box-sizing: border-box;
  padding: 0 16px;
  border-right: 1px solid var(--vp-c-divider);
  border-bottom: 2px solid transparent;
  color: var(--vp-c-text-3);
  font: 12px/1 var(--vp-font-family-mono);
  white-space: nowrap;
  cursor: pointer;
}

.workspace-tabs button[aria-selected="true"] {
  border-bottom-color: var(--ts-c-sql);
  color: var(--vp-c-text-1);
  background: var(--ts-editor-bg);
}

.workspace-tabs button:hover { color: var(--ts-c-sql); }
.workspace-tabs button:focus-visible { outline-offset: -4px; }
.workspace-tabs__label { display: inline-flex; align-items: baseline; gap: 8px; line-height: 20px; }
.workspace-tabs__icon { font-size: 10px; font-weight: 700; color: var(--ts-c-type); }
.workspace-tabs__icon--sql { color: var(--ts-c-amber); }
.workspace-tabs__attention { width: 5px; height: 5px; border-radius: 50%; background: var(--ts-c-red); }
</style>
