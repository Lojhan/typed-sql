import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Axis = "x" | "y";
interface Metric {
  max: number;
  size: number;
  offset: number;
  track: number;
  position: number;
}
interface ScrollMetrics {
  left: number;
  top: number;
  width: number;
  height: number;
  id: string;
  x: Metric;
  y: Metric;
}
/** Shared floating rails, matching the docs ScrollArea without wrapping/remounting editors or views. */
export function GlobalScrollbars() {
  const [metrics, setMetrics] = useState<ScrollMetrics | null>(null),
    [visible, setVisible] = useState(false);
  const target = useRef<HTMLElement | null>(null),
    drag = useRef<{ axis: Axis; pointer: number; scroll: number } | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    measure = useRef<() => void>(() => {});
  const activity = () => {
    setVisible(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!drag.current) setVisible(false);
    }, 1000);
  };
  const activityRef = useRef(activity);
  activityRef.current = activity;
  useEffect(() => {
    let frame = 0,
      sequence = 0;
    const excluded = (element: HTMLElement) => !!element.closest(".cm-editor, .global-scrollbars");
    const resize = new ResizeObserver(() => queue());
    const mutations = new MutationObserver(() => queue());
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const update = () => {
      frame = 0;
      const element = target.current;
      if (!element?.isConnected || excluded(element)) {
        setMetrics(null);
        return;
      }
      const rect = element.getBoundingClientRect();
      let left = Math.max(0, rect.left),
        top = Math.max(0, rect.top),
        right = Math.min(innerWidth, rect.right),
        bottom = Math.min(innerHeight, rect.bottom);
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if ([style.overflowX, style.overflowY].some((value) => value !== "visible")) {
          const clip = parent.getBoundingClientRect();
          left = Math.max(left, clip.left);
          top = Math.max(top, clip.top);
          right = Math.min(right, clip.right);
          bottom = Math.min(bottom, clip.bottom);
        }
      }
      if (right - left < 12 || bottom - top < 12) {
        setMetrics(null);
        return;
      }
      const metric = (axis: Axis): Metric => {
        const viewport = axis === "x" ? element.clientWidth : element.clientHeight,
          total = axis === "x" ? element.scrollWidth : element.scrollHeight,
          position = axis === "x" ? element.scrollLeft : element.scrollTop;
        const track = Math.max(0, (axis === "x" ? right - left : bottom - top) - 4),
          max = Math.max(0, total - viewport),
          size = Math.min(track, Math.max(24, total ? (viewport / total) * track : track));
        return { max, track, size, position, offset: max ? (Math.max(0, position) / max) * (track - size) : 0 };
      };
      if (!element.id) element.id = `typed-sql-scroll-${++sequence}`;
      const next = {
        left,
        top,
        width: right - left,
        height: bottom - top,
        id: element.id,
        x: metric("x"),
        y: metric("y"),
      };
      setMetrics((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    };
    measure.current = queue;
    const choose = (element: HTMLElement) => {
      if (target.current !== element) {
        resize.disconnect();
        mutations.disconnect();
        target.current = element;
        resize.observe(element);
        mutations.observe(element, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["open"],
        });
      }
      queue();
      activityRef.current();
    };
    const scrollable = (element: HTMLElement) => {
      if (excluded(element)) return false;
      const style = getComputedStyle(element);
      return (
        (/auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1) ||
        (/auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1)
      );
    };
    const find = (node: EventTarget | null) => {
      for (let e = node instanceof HTMLElement ? node : null; e; e = e.parentElement) {
        if (excluded(e)) return null;
        if (scrollable(e)) return e;
      }
      return null;
    };
    const onScroll = (event: Event) => {
      const element = event.target;
      if (element instanceof HTMLElement && scrollable(element)) choose(element);
      else if (element instanceof HTMLElement && element.closest(".cm-editor")) setVisible(false);
    };
    const onWheel = (event: WheelEvent) => {
      const element = find(event.target);
      if (element) choose(element);
      else if (event.target instanceof Element && event.target.closest(".cm-editor")) setVisible(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (drag.current || (event.target instanceof Element && event.target.closest(".global-scrollbars"))) return;
      if (event.target instanceof Element && event.target.closest(".cm-editor")) {
        setVisible(false);
        return;
      }
      const element = find(event.target);
      if (!element) return;
      const rect = element.getBoundingClientRect();
      if (rect.right - event.clientX < 14 || rect.bottom - event.clientY < 14) choose(element);
    };
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("wheel", onWheel, { passive: true });
    document.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("resize", queue);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("wheel", onWheel);
      document.removeEventListener("pointermove", onPointer);
      window.removeEventListener("resize", queue);
      resize.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(timer.current);
    };
  }, []);
  if (!metrics) return null;
  const scroll = (axis: Axis, position: number) => {
    const element = target.current;
    if (!element) return;
    if (axis === "x") element.scrollLeft = position;
    else element.scrollTop = position;
    measure.current();
    activity();
  };
  return createPortal(
    <div
      className={`global-scrollbars ${visible ? "is-visible" : ""}`}
      style={{ left: metrics.left, top: metrics.top, width: metrics.width, height: metrics.height }}
    >
      {(["x", "y"] as const).map((axis) => {
        const metric = metrics[axis];
        if (metric.max < 1) return null;
        return (
          <div
            key={axis}
            className={`scroll-overlay-rail ${axis}`}
            role="scrollbar"
            tabIndex={0}
            aria-label={`Content ${axis === "x" ? "horizontal" : "vertical"} scroll`}
            aria-controls={metrics.id}
            aria-orientation={axis === "x" ? "horizontal" : "vertical"}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((metric.position / metric.max) * 100)}
            onFocus={activity}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              const pointer = axis === "x" ? event.clientX : event.clientY;
              if (event.target === event.currentTarget) {
                const rect = event.currentTarget.getBoundingClientRect();
                scroll(
                  axis,
                  ((pointer - (axis === "x" ? rect.left : rect.top) - metric.size / 2) /
                    Math.max(1, metric.track - metric.size)) *
                    metric.max,
                );
              }
              drag.current = {
                axis,
                pointer,
                scroll: axis === "x" ? target.current!.scrollLeft : target.current!.scrollTop,
              };
              activity();
            }}
            onPointerMove={(event) => {
              if (!drag.current) return;
              const current = drag.current;
              scroll(
                axis,
                current.scroll +
                  (((axis === "x" ? event.clientX : event.clientY) - current.pointer) /
                    Math.max(1, metric.track - metric.size)) *
                    metric.max,
              );
            }}
            onPointerUp={() => {
              drag.current = null;
              activity();
            }}
            onLostPointerCapture={() => {
              drag.current = null;
              activity();
            }}
            onKeyDown={(event) => {
              const direction =
                event.key === (axis === "x" ? "ArrowLeft" : "ArrowUp")
                  ? -1
                  : event.key === (axis === "x" ? "ArrowRight" : "ArrowDown")
                    ? 1
                    : 0;
              if (event.key === "Home") scroll(axis, 0);
              else if (event.key === "End") scroll(axis, metric.max);
              else if (event.key === "PageDown") scroll(axis, metric.position + metric.track);
              else if (event.key === "PageUp") scroll(axis, metric.position - metric.track);
              else if (direction) scroll(axis, metric.position + direction * 40);
              else return;
              event.preventDefault();
            }}
          >
            <div
              className="scroll-overlay-thumb"
              style={
                axis === "x"
                  ? { width: metric.size, transform: `translateX(${metric.offset}px)` }
                  : { height: metric.size, transform: `translateY(${metric.offset}px)` }
              }
            />
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
