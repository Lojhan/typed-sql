<script setup lang="ts" generic="Value extends string">
import { ref } from "vue";
import ScrollArea from "./ScrollArea.vue";

const props = defineProps<{
  modelValue: Value;
  items: readonly {
    value: Value;
    label: string;
    title?: string;
    icon?: string;
    iconTone?: "type" | "sql";
    attention?: boolean;
  }[];
  idPrefix: string;
  panelId: string;
  ariaLabel: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: Value] }>();
const root = ref<HTMLElement>();

function navigate(event: KeyboardEvent, index: number) {
  let next: number;
  switch (event.key) {
    case "ArrowRight":
      next = (index + 1) % props.items.length;
      break;
    case "ArrowLeft":
      next = (index - 1 + props.items.length) % props.items.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = props.items.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  const item = props.items[next];
  if (!item) return;
  emit("update:modelValue", item.value);
  root.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
}
</script>

<template>
  <ScrollArea class="workspace-tabs" :label="ariaLabel" fill><div ref="root" class="workspace-tabs__list" role="tablist" :aria-label="ariaLabel">
    <button
      v-for="(item, index) in items"
      :id="`${idPrefix}-${item.value}`"
      :key="item.value"
      type="button"
      role="tab"
      :aria-selected="modelValue === item.value"
      :aria-controls="panelId"
      :title="item.title ?? item.label"
      :tabindex="modelValue === item.value ? 0 : -1"
      @click="emit('update:modelValue', item.value)"
      @keydown="navigate($event, index)"
    >
      <span class="workspace-tabs__label">
        <span v-if="item.icon" class="workspace-tabs__icon" :class="`workspace-tabs__icon--${item.iconTone ?? 'type'}`" aria-hidden="true">{{ item.icon }}</span>
        <span>{{ item.label }}</span>
      </span>
      <span v-if="item.attention" class="workspace-tabs__attention" aria-label="Has problems" />
    </button>
  </div></ScrollArea>
</template>

<style scoped>
.workspace-tabs {
  height: 42px;
  flex-shrink: 0;
  box-sizing: border-box;
  background: var(--ts-editor-panel);
  border-bottom: 1px solid var(--vp-c-divider);
}

.workspace-tabs__list { display: flex; height: 100%; min-width: max-content; }

.workspace-tabs button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  flex-shrink: 0;
  box-sizing: border-box;
  padding: 0 16px;
  border-right: 1px solid var(--vp-c-divider);
  border-bottom: 2px solid transparent;
  color: var(--vp-c-text-3);
  font: 12px/1 var(--vp-font-family-mono);
  white-space: nowrap;
  cursor: pointer;
}

.workspace-tabs button[aria-selected="true"] {
  border-bottom-color: var(--ts-c-sql);
  color: var(--vp-c-text-1);
  background: var(--ts-editor-bg);
}

.workspace-tabs button:hover { color: var(--ts-c-sql); }
.workspace-tabs button:focus-visible { outline-offset: -4px; }
.workspace-tabs__label { display: inline-flex; align-items: baseline; gap: 8px; line-height: 20px; }
.workspace-tabs__icon { font-size: 10px; font-weight: 700; color: var(--ts-c-type); }
.workspace-tabs__icon--sql { color: var(--ts-c-amber); }
.workspace-tabs__attention { width: 5px; height: 5px; border-radius: 50%; background: var(--ts-c-red); }
</style>
