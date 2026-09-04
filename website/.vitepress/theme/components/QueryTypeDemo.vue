<script lang="ts">
import { defineComponent, nextTick, onMounted, type PropType, ref } from "vue";
import type { PlaygroundDialect } from "../playground/playground.js";
import LiveQueryEditor from "./LiveQueryEditor.vue";

export default defineComponent({
  name: "QueryTypeDemo",
  components: { LiveQueryEditor },
  props: {
    dialect: { type: String as PropType<PlaygroundDialect>, default: "postgres" },
  },
  setup() {
    const sourceRoot = ref<HTMLElement>();
    const source = ref("");
    const ready = ref(false);

    onMounted(async () => {
      await nextTick();
      source.value = sourceRoot.value?.querySelector("code")?.textContent?.trimEnd() ?? "";
      ready.value = source.value.length > 0;
    });

    return { ready, source, sourceRoot };
  },
});
</script>

<template>
  <figure class="ts-query-type-demo">
    <LiveQueryEditor
      v-if="ready"
      v-model="source"
      :dialect="dialect"
      filename="account-by-id.ts"
      size="hero"
    />
    <div v-show="!ready" ref="sourceRoot" class="ts-query-type-demo__source">
      <slot name="source" />
    </div>
    <div class="ts-query-type-demo__contract-source" aria-hidden="true"><slot name="result" /></div>
    <figcaption v-if="$slots.caption" class="ts-query-type-demo__caption"><slot name="caption" /></figcaption>
  </figure>
</template>
