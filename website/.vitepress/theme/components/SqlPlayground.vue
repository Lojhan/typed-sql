<script lang="ts">
import { computed, defineComponent, reactive, ref } from "vue";
import {
  DEFAULT_SOURCES,
  PLAYGROUND_DIALECT_LABELS,
  PLAYGROUND_DIALECTS,
  type PlaygroundDialect,
} from "../playground/playground.js";
import LiveQueryEditor from "./LiveQueryEditor.vue";

export default defineComponent({
  name: "SqlPlayground",
  components: { LiveQueryEditor },
  setup() {
    const activeDialect = ref<PlaygroundDialect>("postgres");
    const sources = reactive<Record<PlaygroundDialect, string>>({ ...DEFAULT_SOURCES });
    const canReset = computed(() => sources[activeDialect.value] !== DEFAULT_SOURCES[activeDialect.value]);

    function reset() {
      sources[activeDialect.value] = DEFAULT_SOURCES[activeDialect.value];
    }

    return {
      activeDialect,
      canReset,
      dialects: PLAYGROUND_DIALECTS,
      labels: PLAYGROUND_DIALECT_LABELS,
      reset,
      sources,
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
      <button class="ts-playground__reset" type="button" :disabled="!canReset" @click="reset">Reset query</button>
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
        size="large"
      />
    </div>
  </section>
</template>
