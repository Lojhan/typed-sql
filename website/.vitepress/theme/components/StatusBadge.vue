<script lang="ts">
import { defineComponent, type PropType } from "vue";

type ProductStatus = "stable" | "experimental" | "conditional" | "unsupported";

const labels: Readonly<Record<ProductStatus, string>> = {
  stable: "Stable",
  experimental: "Experimental",
  conditional: "Conditional",
  unsupported: "Unsupported",
};

export default defineComponent({
  name: "StatusBadge",
  props: {
    status: { type: String as PropType<ProductStatus>, required: true },
    label: { type: String, default: undefined },
  },
  computed: {
    resolvedLabel(): string {
      return this.label ?? labels[this.status];
    },
  },
});
</script>

<template>
  <span :class="['ts-status', `ts-status--${status}`]">
    <span class="ts-status__marker" aria-hidden="true" />
    {{ resolvedLabel }}
  </span>
</template>
