<script lang="ts">
import { computed, defineComponent, ref, useId } from "vue";

export default defineComponent({
  name: "QueryTypeDemo",
  props: {
    sourceLabel: { type: String, default: "SQL template" },
    resultLabel: { type: String, default: "Compiler contract" },
  },
  setup() {
    const hovered = ref(false);
    const focused = ref(false);
    const pinned = ref(false);
    const isInspecting = computed(() => hovered.value || focused.value || pinned.value);
    const tooltipId = useId();

    function leaveFocus(event: FocusEvent) {
      const nextTarget = event.relatedTarget;
      focused.value =
        nextTarget instanceof Node && event.currentTarget instanceof Node
          ? event.currentTarget.contains(nextTarget)
          : false;
    }

    return { focused, hovered, isInspecting, leaveFocus, pinned, tooltipId };
  },
});
</script>

<template>
  <figure class="ts-query-type-demo">
    <div
      class="ts-query-type-demo__editor"
      :class="{ 'is-inspecting': isInspecting }"
      @pointerenter="hovered = true"
      @pointerleave="hovered = false"
      @focusin="focused = true"
      @focusout="leaveFocus"
      @keydown.esc="pinned = false"
    >
      <div class="ts-query-type-demo__bar">
        <span class="ts-query-type-demo__file">account-by-id.ts</span>
        <button
          class="ts-query-type-demo__inspect"
          type="button"
          :aria-controls="tooltipId"
          :aria-expanded="isInspecting"
          @click="pinned = !pinned"
        >
          <span class="ts-query-type-demo__inspect-dot" aria-hidden="true" />
          Hover to inspect
        </button>
      </div>

      <div class="ts-query-type-demo__source" tabindex="0" :aria-describedby="tooltipId">
        <slot name="source" />
      </div>

      <aside
        :id="tooltipId"
        class="ts-query-type-demo__hover"
        role="tooltip"
        :aria-hidden="!isInspecting"
      >
        <div class="ts-query-type-demo__hover-label">{{ resultLabel }}</div>
        <div class="ts-query-type-demo__result"><slot name="result" /></div>
      </aside>

      <div class="ts-query-type-demo__status" aria-hidden="true">
        <span>{{ sourceLabel }}</span>
        <span>PostgreSQL</span>
        <span>Ln 3, Col 14</span>
      </div>
    </div>
    <figcaption v-if="$slots.caption" class="ts-query-type-demo__caption"><slot name="caption" /></figcaption>
  </figure>
</template>
