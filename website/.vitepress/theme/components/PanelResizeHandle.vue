<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{
  modelValue: number;
  min: number;
  max: number;
  label: string;
  orientation: "vertical" | "horizontal";
  reverse?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [value: number] }>();
const dragging = ref(false);
let start = 0;
let initial = 0;

function update(value: number) {
  emit("update:modelValue", Math.max(props.min, Math.min(props.max, value)));
}
function begin(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).focus();
  start = props.orientation === "vertical" ? event.clientX : event.clientY;
  initial = props.modelValue;
  dragging.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function move(event: PointerEvent) {
  if (!dragging.value) return;
  const position = props.orientation === "vertical" ? event.clientX : event.clientY;
  update(initial + (position - start) * (props.reverse ? -1 : 1));
}
function key(event: KeyboardEvent) {
  const negative = props.orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
  const positive = props.orientation === "vertical" ? "ArrowRight" : "ArrowDown";
  if (event.key === "Home") update(props.min);
  else if (event.key === "End") update(props.max);
  else if (event.key === negative || event.key === positive)
    update(props.modelValue + (event.key === negative ? -10 : 10) * (props.reverse ? -1 : 1));
  else return;
  event.preventDefault();
}
</script>

<template>
  <div class="panel-resize-handle" :class="[orientation, { 'is-dragging': dragging }]" role="separator" tabindex="0" :aria-label="label" :aria-orientation="orientation" :aria-valuemin="min" :aria-valuemax="Math.round(max)" :aria-valuenow="Math.round(modelValue)" @pointerdown="begin" @pointermove="move" @pointerup="dragging = false" @lostpointercapture="dragging = false" @keydown="key" />
</template>

<style scoped>
.panel-resize-handle { position: relative; z-index: 2; flex-shrink: 0; touch-action: none; user-select: none; background: var(--vp-c-divider); }
.panel-resize-handle.vertical { width: 4px; cursor: col-resize; }
.panel-resize-handle.horizontal { height: 4px; cursor: row-resize; }
.panel-resize-handle:hover, .panel-resize-handle.is-dragging, .panel-resize-handle:focus-visible { background: var(--ts-c-type); outline: none; }
</style>
