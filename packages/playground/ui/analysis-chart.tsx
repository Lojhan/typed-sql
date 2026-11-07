import {
  BarChart,
  FunnelChart,
  HeatmapChart,
  LineChart,
  PieChart,
  SankeyChart,
  ScatterChart,
  SunburstChart,
  TreemapChart,
} from "echarts/charts";
import {
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { init, use } from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { useEffect, useRef, useState } from "react";
import type { AnalysisDataset, AnalysisView } from "../src/analysis-contract";
import { chartOption } from "./analysis-chart-option";
import { EmptyState } from "./components";

use([
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
  BarChart,
  LineChart,
  ScatterChart,
  PieChart,
  SunburstChart,
  TreemapChart,
  HeatmapChart,
  FunnelChart,
  SankeyChart,
  SVGRenderer,
]);
export default function AnalysisChart({
  view,
  rows,
  onExportReady,
  onSelect,
  compact = false,
}: {
  view: AnalysisView;
  rows: AnalysisDataset["rows"];
  onExportReady?: (fn: ((format: "svg" | "png") => void) | null) => void;
  onSelect?: (name: string) => void;
  compact?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null),
    [error, setError] = useState(""),
    [visible, setVisible] = useState(false);
  const select = useRef(onSelect);
  select.current = onSelect;
  const snapshot = useRef<{
    view: AnalysisView;
    rows: AnalysisDataset["rows"];
    theme: string | undefined;
    compact: boolean;
    option: ReturnType<typeof chartOption>;
  } | null>(null);
  useEffect(() => {
    if (!root.current) return;
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting)), {
      rootMargin: "200px",
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    if (!root.current) return;
    const element = root.current,
      chart = init(element, undefined, { renderer: "svg" });
    let drawn = false;
    let renderedTheme: string | undefined;
    const draw = () => {
      try {
        const saved = snapshot.current;
        const option =
          saved?.view === view &&
          saved.rows === rows &&
          saved.theme === document.documentElement.dataset.theme &&
          saved.compact === compact
            ? saved.option
            : chartOption(view, rows, document.documentElement.dataset.theme === "dark");
        if (compact)
          Object.assign(option, {
            legend: { show: false },
            xAxis: { ...option.xAxis, show: false },
            yAxis: { ...option.yAxis, show: false },
            grid: { left: 4, right: 4, top: 4, bottom: 4 },
            dataZoom: [],
          });
        chart.setOption(option, true);
        // The labeled chart container is the accessible image; avoid a nested duplicate.
        element.querySelector("svg")?.setAttribute("aria-hidden", "true");
        drawn = true;
        renderedTheme = document.documentElement.dataset.theme;
        setError("");
      } catch (error) {
        drawn = false;
        setError(error instanceof Error ? error.message : String(error));
      }
    };
    draw();
    chart.on("click", (event) => {
      if (typeof event.name === "string") select.current?.(event.name);
    });
    const resize = new ResizeObserver(() => chart.resize());
    resize.observe(element);
    const theme = new MutationObserver(draw);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    onExportReady?.(
      drawn
        ? (format) => {
            const source = chart.getDataURL({ type: "svg" });
            const width = element.clientWidth,
              height = element.clientHeight;
            const save = (url: string) => {
              const a = document.createElement("a");
              a.download = `${view.title}.${format}`;
              a.href = url;
              a.click();
            };
            if (format === "svg") {
              save(source);
              return;
            }
            // SVG-rendered ECharts always returns SVG, even when getDataURL requests PNG.
            const image = new Image();
            image.onerror = () => setError("Could not export the chart image.");
            image.onload = () => {
              const canvas = document.createElement("canvas");
              canvas.width = Math.max(1, width) * 2;
              canvas.height = Math.max(1, height) * 2;
              const context = canvas.getContext("2d");
              if (!context) {
                setError("Image export is unavailable.");
                return;
              }
              context.fillStyle = document.documentElement.dataset.theme === "dark" ? "#20262d" : "#fff";
              context.fillRect(0, 0, canvas.width, canvas.height);
              context.drawImage(image, 0, 0, canvas.width, canvas.height);
              canvas.toBlob((blob) => {
                if (!blob) {
                  setError("Image export failed.");
                  return;
                }
                const url = URL.createObjectURL(blob);
                save(url);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }, "image/png");
            };
            image.src = source;
          }
        : null,
    );
    return () => {
      resize.disconnect();
      theme.disconnect();
      snapshot.current = drawn
        ? {
            view,
            rows,
            theme: renderedTheme,
            compact,
            option: chart.getOption() as ReturnType<typeof chartOption>,
          }
        : null;
      onExportReady?.(null);
      chart.dispose();
    };
  }, [view, rows, onExportReady, compact, visible]);
  return (
    <div className={`analysis-plot ${compact ? "compact" : ""}`}>
      <div ref={root} role="img" aria-label={view.title} aria-hidden={!!error} style={{ opacity: error ? 0 : 1 }} />
      {error ? <EmptyState error>{error} Exact values remain available in Data.</EmptyState> : null}
    </div>
  );
}
