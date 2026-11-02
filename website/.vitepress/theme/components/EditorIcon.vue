<script setup lang="ts">
defineProps<{ name: "folder" | "file-ts" | "file-sql" | "chevron" | "new-file" | "collapse" | "lock" }>();
</script>

<template>
  <svg class="editor-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path v-if="name === 'folder'" d="M1.5 4a1 1 0 0 1 1-1h3l1.5 1.5h6.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4Z" stroke="currentColor" stroke-linejoin="round" />
    <path v-else-if="name === 'chevron'" d="m6 4 4 4-4 4" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" />
    <g v-else-if="name === 'file-ts'"><rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="currentColor" opacity=".13" /><text x="8" y="11" text-anchor="middle" fill="currentColor" font-family="ui-monospace, monospace" font-size="8" font-weight="600">TS</text></g>
    <g v-else-if="name === 'file-sql'" stroke="currentColor" stroke-linejoin="round"><ellipse cx="8" cy="4" rx="4.5" ry="2" /><path d="M3.5 4v7.5c0 1.1 2 2 4.5 2s4.5-.9 4.5-2V4M3.5 7.5c0 1.1 2 2 4.5 2s4.5-.9 4.5-2" /></g>
    <g v-else-if="name === 'new-file'" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 1.5H3v13h10V5L9.5 1.5ZM9 1.5v4h4M8 8v4M6 10h4" /></g>
    <g v-else-if="name === 'lock'" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="7" rx="1" /><path d="M5 7V5a3 3 0 0 1 6 0v2M8 10v1" /></g>
    <g v-else stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1" /><path d="M6 2.5v11" /></g>
  </svg>
</template>

<style scoped>
.editor-icon { display: inline-block; width: 16px; height: 16px; flex: 0 0 16px; vertical-align: middle; }
</style>
