<script setup lang="ts">
defineProps<{
  steps: readonly string[];
  label?: string;
}>();
</script>

<template>
  <ol class="ts-step-flow" :aria-label="label ?? 'Process'">
    <li v-for="(step, index) in steps" :key="step" class="ts-step-flow__step">
      <span class="ts-step-flow__number" aria-hidden="true">{{ index + 1 }}</span>
      <span>{{ step }}</span>
    </li>
  </ol>
</template>
