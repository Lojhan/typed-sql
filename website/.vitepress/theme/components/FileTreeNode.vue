<script setup lang="ts">
import { dragEditorFile } from "../playground/editor-layout.js";
import EditorIcon from "./EditorIcon.vue";
import FileTreeNameInput, { type TreeNameEdit } from "./FileTreeNameInput.vue";
export interface FileTreeEntry {
  name: string;
  path: string;
  children?: FileTreeEntry[];
  readonly?: boolean;
  draft?: boolean;
}

withDefaults(
  defineProps<{
    entry: FileTreeEntry;
    activeFile: string;
    problems: readonly string[];
    depth?: number;
    edit?: TreeNameEdit;
    dropFolder?: string;
  }>(),
  {
    depth: 0,
  },
);
const emit = defineEmits<{
  select: [path: string];
  context: [event: MouseEvent, entry: FileTreeEntry];
  rename: [entry: FileTreeEntry];
  delete: [entry: FileTreeEntry];
}>();
function key(event: KeyboardEvent, entry: FileTreeEntry) {
  if (entry.readonly || (event.target as HTMLElement).tagName === "INPUT") return;
  if (event.key === "F2") {
    event.preventDefault();
    emit("rename", entry);
  }
  if (event.key === "Delete") {
    event.preventDefault();
    emit("delete", entry);
  }
}
</script>

<template>
  <li :style="{ '--pg-entry-depth': depth }">
    <details v-if="entry.children" open>
      <summary class="pg-file-row" :class="{ 'is-drop-target': dropFolder === entry.path }" :draggable="!entry.draft && edit?.target !== entry.path" :data-tree-path="entry.path" data-tree-folder="true" :title="entry.path" @contextmenu.stop="emit('context', $event, entry)" @keydown="key($event, entry)"><EditorIcon name="chevron" class="pg-folder-chevron" /><EditorIcon name="folder" class="pg-folder-icon" /><FileTreeNameInput v-if="edit && (entry.draft || edit.target === entry.path)" :edit="edit" /><span v-else class="pg-file-name">{{ entry.name }}</span></summary>
      <p v-if="edit?.error && (entry.draft || edit.target === entry.path)" id="pg-entry-error" class="pg-entry-error" role="alert">{{ edit.error }}</p>
      <ul><FileTreeNode v-for="child in entry.children" :key="child.path" :entry="child" :active-file="activeFile" :problems="problems" :depth="depth + 1" :edit="edit" :drop-folder="dropFolder" @select="emit('select', $event)" @context="(event, node) => emit('context', event, node)" @rename="emit('rename', $event)" @delete="emit('delete', $event)" /></ul>
    </details>
    <component :is="edit?.target === entry.path || entry.draft ? 'div' : 'button'" v-else @contextmenu.stop="emit('context', $event, entry)" @keydown="key($event, entry)" :draggable="!entry.draft && edit?.target !== entry.path" @dragstart="dragEditorFile($event, entry.path)" class="pg-file-row" :data-tree-path="entry.path" :data-tree-readonly="entry.readonly ? 'true' : undefined" type="button" :class="{ 'is-active': activeFile === entry.path }" :aria-current="activeFile === entry.path ? 'page' : undefined" :title="entry.readonly ? `${entry.name} · Read only` : entry.path" @click="!entry.draft && emit('select', entry.path)">
      <span aria-hidden="true" />
      <EditorIcon :name="(entry.draft ? edit?.name : entry.path)?.endsWith('.sql') ? 'file-sql' : 'file-ts'" class="pg-file-icon" :class="{ 'is-sql': entry.path.endsWith('.sql') }" />
      <FileTreeNameInput v-if="edit && (entry.draft || edit.target === entry.path)" :edit="edit" /><span v-else class="pg-file-name">{{ entry.name }}</span>
      <span v-if="problems.includes(entry.path)" class="pg-file-error" aria-label="Has problems">●</span>
      <EditorIcon v-else-if="entry.readonly" name="lock" class="pg-file-lock" />
    </component>
    <p v-if="!entry.children && edit?.error && (entry.draft || edit.target === entry.path)" id="pg-entry-error" class="pg-entry-error" role="alert">{{ edit.error }}</p>
  </li>
</template>
