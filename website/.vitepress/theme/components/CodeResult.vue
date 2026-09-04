<script setup lang="ts">
withDefaults(
  defineProps<{
    sourceLabel?: string;
    resultLabel?: string;
  }>(),
  {
    sourceLabel: "SQL template",
    resultLabel: "Compiler result",
  },
);
</script>

<template>
  <div class="ts-code-result">
    <section class="ts-code-result__panel" :aria-label="sourceLabel">
      <div class="ts-code-result__label">{{ sourceLabel }}</div>
      <div class="ts-code-result__content"><slot name="source" /></div>
    </section>
    <section class="ts-code-result__panel ts-code-result__panel--result" :aria-label="resultLabel">
      <div class="ts-code-result__label">{{ resultLabel }}</div>
      <div class="ts-code-result__content"><slot name="result" /></div>
    </section>
  </div>
</template>
