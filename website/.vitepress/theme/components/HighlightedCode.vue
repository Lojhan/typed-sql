<script setup lang="ts">
import { computed } from "vue";
import type { PlaygroundDialect } from "../playground/playground.js";
import { highlightSource } from "../playground/type-highlighting.js";

const props = withDefaults(
  defineProps<{ source: string; language?: "typescript" | "sql"; dialect?: PlaygroundDialect }>(),
  { language: "typescript", dialect: "postgres" },
);
const tokens = computed(() => highlightSource(props.source, props.language, props.dialect));
</script>

<template>
  <pre class="ts-type-code"><code><span v-for="(token, index) in tokens" :key="index" :class="token.className">{{ token.text }}</span></code></pre>
</template>
