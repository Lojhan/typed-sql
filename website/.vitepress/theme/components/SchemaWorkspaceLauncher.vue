<script lang="ts">
import { defineAsyncComponent, defineComponent, onMounted, ref, watch } from "vue";
import { useSchemaWorkspace } from "../playground/schema-store.js";

const SchemaWorkspace = defineAsyncComponent(() => import("./SchemaWorkspace.vue"));

export default defineComponent({
  name: "SchemaWorkspaceLauncher",
  components: { SchemaWorkspace },
  setup() {
    const workspace = useSchemaWorkspace();
    const activated = ref(false);
    onMounted(() => workspace.hydrate());
    watch(
      workspace.isOpen,
      (open) => {
        if (open) activated.value = true;
      },
      { immediate: true },
    );
    return { activated, workspace };
  },
});
</script>

<template>
  <button class="ts-schema-trigger" type="button" @click="workspace.open()">
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <ellipse cx="10" cy="4" rx="6.5" ry="2.5" />
      <path d="M3.5 4v6c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V4M3.5 10v6c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-6" />
    </svg>
    Schemas
  </button>
  <SchemaWorkspace v-if="activated" />
</template>
