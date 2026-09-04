<script setup lang="ts">
withDefaults(defineProps<{ title?: string }>(), { title: "Continue" });
</script>

<template>
  <aside class="ts-next-steps" :aria-label="title">
    <p class="ts-next-steps__title">{{ title }}</p>
    <div class="ts-next-steps__links"><slot /></div>
  </aside>
</template>
