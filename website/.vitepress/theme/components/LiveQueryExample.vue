<script lang="ts">
import { defineComponent, nextTick, onMounted, type PropType, ref } from "vue";
import type { PlaygroundDialect } from "../playground/playground.js";
import LiveQueryEditor from "./LiveQueryEditor.vue";

export default defineComponent({
  name: "LiveQueryExample",
  components: { LiveQueryEditor },
  props: {
    dialect: { type: String as PropType<PlaygroundDialect>, required: true },
    filename: { type: String, default: "main.ts" },
    sourceLabel: { type: String, default: "Live example" },
  },
  setup() {
    const sourceRoot = ref<HTMLElement>();
    const source = ref("");
    const initialSource = ref("");
    const ready = ref(false);

    onMounted(async () => {
      await nextTick();
      const value = sourceRoot.value?.querySelector("code")?.textContent?.trimEnd() ?? "";
      source.value = value;
      initialSource.value = value;
      ready.value = value.length > 0;
    });

    function reset() {
      source.value = initialSource.value;
    }

    return { initialSource, ready, reset, source, sourceRoot };
  },
});
</script>

<template>
  <div class="ts-live-example">
    <LiveQueryEditor
      v-if="ready"
      v-model="source"
      :dialect="dialect"
      :filename="filename"
      :source-label="sourceLabel"
      size="inline"
    />
    <div v-show="!ready" ref="sourceRoot" class="ts-live-example__source"><slot name="source" /></div>
    <button v-if="ready && source !== initialSource" class="ts-live-example__reset" type="button" @click="reset">
      Reset example
    </button>
    <p v-if="$slots.caption" class="ts-live-example__caption"><slot name="caption" /></p>
  </div>
</template>
