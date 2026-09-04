<script setup lang="ts">
withDefaults(defineProps<{ label?: string }>(), { label: "Choose a path" });
</script>

<template>
  <nav class="ts-path-cards" :aria-label="label"><slot /></nav>
</template>
