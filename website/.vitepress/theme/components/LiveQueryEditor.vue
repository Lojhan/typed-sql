<script lang="ts">
import { computed, defineComponent, type PropType } from "vue";
import { editorDiagnostics, queryHovers } from "../playground/editor-support.js";
import { analyzePlayground, PLAYGROUND_DIALECT_LABELS, type PlaygroundDialect } from "../playground/playground.js";
import { useSchemaWorkspace } from "../playground/schema-store.js";
import CodeEditor from "./CodeEditor.vue";

export default defineComponent({
  name: "LiveQueryEditor",
  components: { CodeEditor },
  props: {
    modelValue: { type: String, required: true },
    dialect: { type: String as PropType<PlaygroundDialect>, required: true },
    filename: { type: String, default: "main.ts" },
    size: { type: String as PropType<"hero" | "large" | "inline">, default: "inline" },
  },
  emits: {
    "update:modelValue": (value: string) => typeof value === "string",
  },
  setup(props) {
    const workspace = useSchemaWorkspace();
    const result = computed(() => analyzePlayground(props.dialect, workspace.schemas[props.dialect], props.modelValue));
    const diagnostics = computed(() =>
      editorDiagnostics(
        props.modelValue,
        result.value.diagnostics.filter(({ file }) => file === "main.ts"),
      ),
    );
    const schemaProblems = computed(() => result.value.diagnostics.filter(({ file }) => file === "schema.sql").length);
    const hovers = computed(() => queryHovers(props.modelValue, result.value.queries));
    const status = computed(() => {
      if (schemaProblems.value > 0)
        return `${schemaProblems.value} schema problem${schemaProblems.value === 1 ? "" : "s"}`;
      if (diagnostics.value.length > 0)
        return `${diagnostics.value.length} problem${diagnostics.value.length === 1 ? "" : "s"}`;
      const query = result.value.queries[0];
      return query === undefined ? "No query found" : `Hover ${query.binding} for its type`;
    });

    return { diagnostics, hovers, labels: PLAYGROUND_DIALECT_LABELS, result, schemaProblems, status, workspace };
  },
});
</script>

<template>
  <section class="ts-live-query" :class="`ts-live-query--${size}`" :aria-label="`${labels[dialect]} live query editor`">
    <header class="ts-live-query__toolbar">
      <span class="ts-live-query__file">{{ filename }}</span>
    </header>
    <CodeEditor
      :model-value="modelValue"
      language="typescript"
      :aria-label="`${labels[dialect]} TypeScript query source`"
      :invalid="diagnostics.length > 0 || schemaProblems > 0"
      :diagnostics="diagnostics"
      :hovers="hovers"
      @update:model-value="$emit('update:modelValue', $event)"
    />
    <footer class="ts-live-query__status" :class="{ 'has-errors': diagnostics.length > 0 || schemaProblems > 0 }" aria-live="polite">
      <span>{{ status }}</span>
    </footer>
  </section>
</template>
