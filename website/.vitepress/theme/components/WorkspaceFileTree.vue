<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { filePathError, WORKSPACE_LIMITS } from "../playground/workspace.js";
import { WORKSPACE_CONFIG_NAME, WORKSPACE_CONFIG_PATH } from "../playground/workspace-ui.js";
import EditorIcon from "./EditorIcon.vue";
import FileTreeNode, { type FileTreeEntry } from "./FileTreeNode.vue";
import ScrollArea from "./ScrollArea.vue";

const props = defineProps<{ files: readonly string[]; activeFile: string; problems: readonly string[] }>();
const emit = defineEmits<{ select: [path: string]; create: [path: string] }>();
const creating = ref(false);
const path = ref("");
const error = ref("");
const input = ref<HTMLInputElement>();
const entries = computed(() => {
  const root: FileTreeEntry[] = [];
  for (const file of [...props.files].sort()) {
    if (file === WORKSPACE_CONFIG_PATH) {
      root.push({
        name: props.files.includes(WORKSPACE_CONFIG_NAME) ? "playground.config (read only)" : WORKSPACE_CONFIG_NAME,
        path: file,
        readonly: true,
      });
      continue;
    }
    let children = root;
    const parts = file.split("/");
    parts.forEach((name, index) => {
      const folder = index < parts.length - 1;
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
  return root;
});

async function startCreating() {
  creating.value = true;
  error.value = "";
  await nextTick();
  input.value?.focus();
}
function create() {
  const name = path.value.trim();
  const userFiles = props.files.filter((file) => file !== WORKSPACE_CONFIG_PATH);
  error.value =
    name === WORKSPACE_CONFIG_NAME
      ? "This name is reserved for the read-only playground config."
      : (filePathError(name) ??
        (userFiles.includes(name)
          ? "A file with this path already exists."
          : userFiles.some((file) => file.startsWith(`${name}/`) || name.startsWith(`${file}/`))
            ? "A file and a folder cannot have the same path."
            : userFiles.length >= WORKSPACE_LIMITS.files
              ? "The playground supports up to 40 files."
              : ""));
  if (error.value) return;
  emit("create", name);
  creating.value = false;
  path.value = "";
}
</script>

<template>
  <nav class="pg-file-tree" aria-label="Workspace files">
    <header><span>Project</span><button type="button" title="New file" aria-label="New file" @click="startCreating"><EditorIcon name="new-file" /></button></header>
    <form v-if="creating" class="pg-new-file" @submit.prevent="create">
      <input ref="input" v-model="path" aria-label="New file path" placeholder="queries/account.sql" :aria-invalid="Boolean(error)" @keydown.esc="creating = false" />
      <div><button type="submit">Create</button><button type="button" @click="creating = false">Cancel</button></div>
      <p v-if="error" role="alert">{{ error }}</p>
    </form>
    <ScrollArea class="pg-file-list" label="File tree"><ul class="pg-file-entries"><FileTreeNode v-for="entry in entries" :key="entry.path" :entry="entry" :active-file="activeFile" :problems="problems" @select="emit('select', $event)" /></ul></ScrollArea>
  </nav>
</template>
