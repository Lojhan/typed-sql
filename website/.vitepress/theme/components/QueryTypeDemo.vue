<script setup lang="ts">
withDefaults(
  defineProps<{
    sourceLabel?: string;
    resultLabel?: string;
  }>(),
  {
    sourceLabel: "SQL template",
    resultLabel: "Compiler contract",
  },
);
</script>

<template>
  <figure class="ts-query-type-demo">
    <CodeResult :source-label="sourceLabel" :result-label="resultLabel">
      <template #source><slot name="source" /></template>
      <template #result><slot name="result" /></template>
    </CodeResult>
    <figcaption v-if="$slots.caption" class="ts-query-type-demo__caption"><slot name="caption" /></figcaption>
  </figure>
</template>
