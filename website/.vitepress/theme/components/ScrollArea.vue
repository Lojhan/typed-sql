<script setup lang="ts">
import { onBeforeUnmount, onMounted, onUpdated, reactive, ref, useId } from "vue";

withDefaults(defineProps<{ label?: string; fill?: boolean }>(), { label: "Scrollable content", fill: false });
type Axis = "x" | "y";
const id = `scroll-${useId()}`;
const root = ref<HTMLElement>();
const viewport = ref<HTMLElement>();
const content = ref<HTMLElement>();
const metrics = reactive({ x: { max: 0, size: 0, offset: 0, track: 0 }, y: { max: 0, size: 0, offset: 0, track: 0 } });
const dragging = ref<Axis>();
const visible = ref(false);
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let frame = 0;
let resize: ResizeObserver | undefined;
let mutations: MutationObserver | undefined;
let initialPointer = 0;
let initialScroll = 0;

function measure() {
  frame = 0;
  const view = viewport.value;
  const element = root.value;
  if (!view || !element) return;
  for (const axis of ["x", "y"] as const) {
    const visible = axis === "x" ? view.clientWidth : view.clientHeight;
    const total = axis === "x" ? view.scrollWidth : view.scrollHeight;
    const position = axis === "x" ? view.scrollLeft : view.scrollTop;
    const track = Math.max(0, (axis === "x" ? element.clientWidth : element.clientHeight) - 4);
    const max = Math.max(0, total - visible);
    const size = Math.min(track, Math.max(24, total ? (visible / total) * track : track));
    Object.assign(metrics[axis], { max, track, size, offset: max ? (position / max) * (track - size) : 0 });
  }
}

function queueMeasure() {
  if (!frame) frame = requestAnimationFrame(measure);
}
function activity() {
  visible.value = true;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!dragging.value) visible.value = false;
  }, 800);
}
function onScroll() {
  queueMeasure();
  activity();
}
function finish() {
  dragging.value = undefined;
  activity();
}
function scroll(axis: Axis, position: number) {
  if (!viewport.value) return;
  if (axis === "x") viewport.value.scrollLeft = position;
  else viewport.value.scrollTop = position;
  queueMeasure();
  activity();
}
function begin(event: PointerEvent, axis: Axis) {
  if (event.button !== 0 || !viewport.value) return;
  event.preventDefault();
  const rail = event.currentTarget as HTMLElement;
  rail.focus();
  rail.setPointerCapture(event.pointerId);
  dragging.value = axis;
  activity();
  initialPointer = axis === "x" ? event.clientX : event.clientY;
  const metric = metrics[axis];
  if (event.target === rail) {
    const rect = rail.getBoundingClientRect();
    const point = initialPointer - (axis === "x" ? rect.left : rect.top);
    scroll(axis, ((point - metric.size / 2) / Math.max(1, metric.track - metric.size)) * metric.max);
  }
  initialScroll = axis === "x" ? viewport.value.scrollLeft : viewport.value.scrollTop;
}
function move(event: PointerEvent) {
  const axis = dragging.value;
  if (!axis) return;
  const metric = metrics[axis];
  const delta = (axis === "x" ? event.clientX : event.clientY) - initialPointer;
  scroll(axis, initialScroll + (delta / Math.max(1, metric.track - metric.size)) * metric.max);
}
function key(event: KeyboardEvent, axis: Axis) {
  if (!viewport.value) return;
  const current = axis === "x" ? viewport.value.scrollLeft : viewport.value.scrollTop;
  const direction =
    event.key === (axis === "x" ? "ArrowLeft" : "ArrowUp")
      ? -1
      : event.key === (axis === "x" ? "ArrowRight" : "ArrowDown")
        ? 1
        : 0;
  if (event.key === "Home") scroll(axis, 0);
  else if (event.key === "End") scroll(axis, metrics[axis].max);
  else if (direction) scroll(axis, current + direction * 40);
  else return;
  event.preventDefault();
}

onMounted(() => {
  resize = new ResizeObserver(queueMeasure);
  if (viewport.value) resize.observe(viewport.value);
  if (content.value) {
    resize.observe(content.value);
    mutations = new MutationObserver(queueMeasure);
    mutations.observe(content.value, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["open"],
    });
  }
  queueMeasure();
});
onUpdated(queueMeasure);
onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  clearTimeout(hideTimer);
  resize?.disconnect();
  mutations?.disconnect();
});
</script>

<template>
  <div ref="root" class="pg-scroll-area" :class="{ 'is-scrolling': dragging, 'is-filled': fill, 'has-scroll-interaction': visible }" @pointerenter="activity" @pointermove.passive="activity">
    <div :id="id" ref="viewport" class="pg-scroll-area__viewport" @scroll.passive="onScroll" @wheel.passive="activity"><div ref="content" class="pg-scroll-area__content"><slot /></div></div>
    <template v-for="axis in (['x', 'y'] as const)" :key="axis">
      <div v-if="metrics[axis].max > 1" class="pg-scroll-area__rail" :class="axis" role="scrollbar" tabindex="0" :aria-label="`${label} ${axis === 'x' ? 'horizontal' : 'vertical'} scroll`" :aria-controls="id" :aria-orientation="axis === 'x' ? 'horizontal' : 'vertical'" :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="Math.round(metrics[axis].offset / Math.max(1, metrics[axis].track - metrics[axis].size) * 100)" @focus="activity" @pointerdown="begin($event, axis)" @pointermove="move" @pointerup="finish" @lostpointercapture="finish" @keydown="key($event, axis)">
        <div class="pg-scroll-area__thumb" :style="axis === 'y' ? { height: `${metrics.y.size}px`, transform: `translateY(${metrics.y.offset}px)` } : { width: `${metrics.x.size}px`, transform: `translateX(${metrics.x.offset}px)` }" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.pg-scroll-area { position: relative; min-width: 0; min-height: 0; overflow: hidden; }
.pg-scroll-area__viewport { width: 100%; height: 100%; min-height: 0; overflow: auto; scrollbar-width: none; scrollbar-gutter: auto; }
.pg-scroll-area__viewport::-webkit-scrollbar { display: none; width: 0; height: 0; }
.pg-scroll-area__content { min-width: 100%; min-height: 100%; display: flow-root; }
.is-filled > .pg-scroll-area__viewport > .pg-scroll-area__content { height: 100%; }
.pg-scroll-area__rail { position: absolute; z-index: 5; opacity: 0; pointer-events: none; transition: opacity 180ms ease; touch-action: none; user-select: none; outline: none; }
.pg-scroll-area__rail.y { top: 2px; bottom: 2px; right: 0; width: 8px; }
.pg-scroll-area__rail.x { left: 2px; right: 2px; bottom: 0; height: 8px; }
.pg-scroll-area__thumb { position: absolute; border-radius: 4px; background: var(--vp-c-text-3); }
.y > .pg-scroll-area__thumb { left: 2px; width: 4px; }
.x > .pg-scroll-area__thumb { top: 2px; height: 4px; }
.pg-scroll-area.has-scroll-interaction > .pg-scroll-area__rail, .pg-scroll-area.is-scrolling > .pg-scroll-area__rail, .pg-scroll-area__rail:focus-visible { opacity: .85; pointer-events: auto; }
.pg-scroll-area__rail:focus-visible > .pg-scroll-area__thumb { background: var(--ts-c-type); }
@media (prefers-reduced-motion: reduce) { .pg-scroll-area__rail { transition: none; } }
</style>
