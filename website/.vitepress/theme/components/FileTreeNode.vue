<script setup lang="ts">
import { dragEditorFile } from "../playground/editor-layout.js";
import EditorIcon from "./EditorIcon.vue";
export interface FileTreeEntry {
  name: string;
  path: string;
  children?: FileTreeEntry[];
  readonly?: boolean;
}

withDefaults(defineProps<{ entry: FileTreeEntry; activeFile: string; problems: readonly string[]; depth?: number }>(), {
  depth: 0,
});
const emit = defineEmits<{ select: [path: string] }>();
</script>

<template>
  <li :style="{ '--pg-entry-depth': depth }">
    <details v-if="entry.children" open>
      <summary class="pg-file-row"><EditorIcon name="chevron" class="pg-folder-chevron" /><EditorIcon name="folder" class="pg-folder-icon" /><span class="pg-file-name">{{ entry.name }}</span></summary>
      <ul><FileTreeNode v-for="child in entry.children" :key="child.path" :entry="child" :active-file="activeFile" :problems="problems" :depth="depth + 1" @select="emit('select', $event)" /></ul>
    </details>
    <button v-else draggable="true" @dragstart="dragEditorFile($event, entry.path)" class="pg-file-row" type="button" :class="{ 'is-active': activeFile === entry.path }" :aria-current="activeFile === entry.path ? 'page' : undefined" :title="entry.readonly ? `${entry.name} · Read only` : entry.path" @click="emit('select', entry.path)">
      <span aria-hidden="true" />
      <EditorIcon :name="entry.path.endsWith('.sql') ? 'file-sql' : 'file-ts'" class="pg-file-icon" :class="{ 'is-sql': entry.path.endsWith('.sql') }" />
      <span class="pg-file-name">{{ entry.name }}</span>
      <span v-if="problems.includes(entry.path)" class="pg-file-error" aria-label="Has problems">●</span>
      <EditorIcon v-else-if="entry.readonly" name="lock" class="pg-file-lock" />
    </button>
  </li>
</template>
