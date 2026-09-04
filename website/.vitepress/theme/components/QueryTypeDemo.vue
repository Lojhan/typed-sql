<script lang="ts">
import { computed, defineComponent, nextTick, onMounted, ref } from "vue";
import CodeEditor, { type CodeEditorHover } from "./CodeEditor.vue";

export default defineComponent({
  name: "QueryTypeDemo",
  components: { CodeEditor },
  props: {
    sourceLabel: { type: String, default: "SQL template" },
    inspectTarget: { type: String, required: true },
  },
  setup(props) {
    const sourceRoot = ref<HTMLElement>();
    const resultRoot = ref<HTMLElement>();
    const source = ref("");
    const contract = ref("");
    const ready = ref(false);
    const hovers = computed<readonly CodeEditorHover[]>(() => {
      const start = source.value.indexOf(props.inspectTarget);
      if (start < 0 || contract.value.length === 0) return [];
      return [{ from: start, to: start + props.inspectTarget.length, content: contract.value }];
    });

    onMounted(async () => {
      await nextTick();
      source.value = sourceRoot.value?.querySelector("code")?.textContent?.trimEnd() ?? "";
      contract.value = resultRoot.value?.querySelector("code")?.textContent?.trim() ?? "";
      ready.value = source.value.length > 0;
    });

    return { hovers, ready, resultRoot, source, sourceRoot };
  },
});
</script>

<template>
  <figure class="ts-query-type-demo">
    <div class="ts-query-type-demo__editor">
      <div class="ts-query-type-demo__bar">
        <span class="ts-query-type-demo__file">account-by-id.ts</span>
        <span>Hover <code>{{ inspectTarget }}</code></span>
      </div>

      <CodeEditor
        v-if="ready"
        v-model="source"
        language="typescript"
        aria-label="Read-only typed-sql query example"
        readonly
        :hovers="hovers"
      />
      <div v-show="!ready" ref="sourceRoot" class="ts-query-type-demo__source">
        <slot name="source" />
      </div>
      <div ref="resultRoot" class="ts-query-type-demo__contract-source" aria-hidden="true">
        <slot name="result" />
      </div>

      <div class="ts-query-type-demo__status" aria-hidden="true">
        <span>{{ sourceLabel }}</span>
        <span>PostgreSQL</span>
        <span>Ln 3, Col 14</span>
      </div>
    </div>
    <figcaption v-if="$slots.caption" class="ts-query-type-demo__caption"><slot name="caption" /></figcaption>
  </figure>
</template>
