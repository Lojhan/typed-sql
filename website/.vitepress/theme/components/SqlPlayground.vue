<script lang="ts">
import { defineComponent, reactive, ref } from "vue";
import {
  DEFAULT_SOURCES,
  PLAYGROUND_DIALECT_LABELS,
  PLAYGROUND_DIALECTS,
  type PlaygroundDialect,
} from "../playground/playground.js";
import { useSchemaWorkspace } from "../playground/schema-store.js";
import LiveQueryEditor from "./LiveQueryEditor.vue";

export default defineComponent({
  name: "SqlPlayground",
  components: { LiveQueryEditor },
  setup() {
    const workspace = useSchemaWorkspace();
    const activeDialect = ref<PlaygroundDialect>("postgres");
    const sources = reactive<Record<PlaygroundDialect, string>>({ ...DEFAULT_SOURCES });

    function reset() {
      sources[activeDialect.value] = DEFAULT_SOURCES[activeDialect.value];
    }

    return {
      activeDialect,
      dialects: PLAYGROUND_DIALECTS,
      labels: PLAYGROUND_DIALECT_LABELS,
      reset,
      sources,
      workspace,
    };
  },
});
</script>

<template>
  <section class="ts-playground" aria-label="Interactive typed-sql playground">
    <header class="ts-playground__toolbar">
      <div class="ts-playground__tabs" role="tablist" aria-label="SQL grammar">
        <button
          v-for="dialect in dialects"
          :id="`playground-tab-${dialect}`"
          :key="dialect"
          class="ts-playground__tab"
          :class="{ 'is-active': activeDialect === dialect }"
          type="button"
          role="tab"
          :aria-selected="activeDialect === dialect"
          :aria-controls="`playground-panel-${dialect}`"
          @click="activeDialect = dialect"
        >
          {{ labels[dialect] }}
        </button>
      </div>
      <button class="ts-playground__reset" type="button" @click="reset">Reset query</button>
    </header>

    <div
      v-for="dialect in dialects"
      :id="`playground-panel-${dialect}`"
      :key="dialect"
      v-show="activeDialect === dialect"
      role="tabpanel"
      :aria-labelledby="`playground-tab-${dialect}`"
    >
      <LiveQueryEditor
        v-model="sources[dialect]"
        :dialect="dialect"
        filename="main.ts"
        source-label="Browser analysis"
        size="large"
      />
    </div>

    <footer class="ts-playground__note">
      Hover a query binding, an adapter result, or an indexed row for its inferred type. Problems use editor squiggles
      and the lint gutter; press <kbd>F8</kbd> to move between them. Each grammar runs locally against the matching
      schema saved in this browser. Open
      <button type="button" @click="workspace.open(activeDialect)">Schemas</button> to change the shared evidence.
    </footer>
  </section>
</template>
