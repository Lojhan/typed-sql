import { Decimal } from "decimal.js";
import type { EChartsOption } from "echarts";
import type { AnalysisDataset, AnalysisView } from "../src/analysis-contract";
import { cellText, chartNumber, decimalValue, hierarchyData } from "../src/analysis-model";

const colors = ["#4c9ed9", "#60b79e", "#d9ae55", "#a994df", "#dc8397", "#70baca", "#b8b96d", "#b58e6d"];

export function chartOption(view: AnalysisView, rows: AnalysisDataset["rows"], dark: boolean): EChartsOption {
  const base: EChartsOption = {
    backgroundColor: "transparent",
    animation: false,
    color: colors,
    textStyle: { color: dark ? "#d8e0e6" : "#243746", fontSize: 12 },
    aria: { enabled: true, description: view.description ?? view.title, decal: { show: false } },
    tooltip: { trigger: "item", renderMode: "richText", confine: true },
    legend: { type: "scroll", bottom: 0, textStyle: { color: dark ? "#a9b7c3" : "#526b7b" } },
    grid: { left: 50, right: 20, top: 24, bottom: 60, containLabel: true },
  };
  const axis = {
    axisLabel: { color: dark ? "#a9b7c3" : "#526b7b" },
    axisLine: { lineStyle: { color: dark ? "#586673" : "#aab9c4" } },
    splitLine: { lineStyle: { color: dark ? "#35414b" : "#e0e7ed" } },
  };
  const numeric = (row: AnalysisDataset["rows"][number], field: number) => {
    const n = decimalValue(row[field]);
    if (!n)
      throw new Error(
        "The selected measure contains missing or nonnumeric values. Inspect Data or choose a different measure.",
      );
    return n;
  };
  if (view.kind === "sunburst")
    return {
      ...base,
      series: [
        {
          type: "sunburst",
          data: hierarchyData(view, rows),
          radius: [0, "85%"],
          nodeClick: "rootToNode",
          label: { show: true },
          emphasis: { focus: "ancestor" },
        },
      ],
    };
  if (view.kind === "treemap")
    return {
      ...base,
      series: [
        {
          type: "treemap",
          data: hierarchyData(view, rows),
          roam: false,
          nodeClick: "zoomToNode",
          breadcrumb: { show: true },
          label: { show: true },
          emphasis: { focus: "ancestor" },
        },
      ],
    };
  if (view.kind === "scatter")
    return {
      ...base,
      xAxis: { ...axis, type: "value", name: "" },
      yAxis: { ...axis, type: "value" },
      series: [
        {
          type: "scatter",
          symbolSize: 8,
          data: rows.map((row) => [chartNumber(numeric(row, view.x!)), chartNumber(numeric(row, view.y!))]),
        },
      ],
    };
  if (view.kind === "histogram") {
    const numbers = rows.map((row) => chartNumber(numeric(row, view.x!)));
    if (!numbers.length) return base;
    const min = Math.min(...numbers),
      max = Math.max(...numbers),
      bins = Math.min(20, Math.max(1, Math.ceil(Math.sqrt(numbers.length)))),
      width = (max - min) / bins || 1;
    const counts = Array.from({ length: bins }, () => 0);
    for (const number of numbers) counts[Math.min(bins - 1, Math.floor((number - min) / width))]!++;
    return {
      ...base,
      xAxis: {
        ...axis,
        type: "category",
        data: counts.map((_, i) => `${new Decimal(min).plus(new Decimal(width).times(i)).toSignificantDigits(6)}`),
      },
      yAxis: { ...axis, type: "value", name: "Rows" },
      series: [{ type: "bar", barCategoryGap: 0, data: counts }],
    };
  }
  if (view.kind === "heatmap") {
    const xs = [...new Set(rows.map((row) => cellText(row[view.x!])))],
      ys = [...new Set(rows.map((row) => cellText(row[view.series!])))];
    const cells = new Map<string, { x: number; y: number; sum: Decimal }>();
    for (const row of rows) {
      const x = xs.indexOf(cellText(row[view.x!])),
        y = ys.indexOf(cellText(row[view.series!])),
        key = `${x}:${y}`;
      const previous = cells.get(key);
      cells.set(key, { x, y, sum: (previous?.sum ?? new Decimal(0)).plus(numeric(row, view.y!)) });
    }
    const data = [...cells.values()].map((cell) => [cell.x, cell.y, chartNumber(cell.sum)]);
    return {
      ...base,
      xAxis: { ...axis, type: "category", data: xs },
      yAxis: { ...axis, type: "category", data: ys },
      series: [{ type: "heatmap", data, label: { show: true } }],
      visualMap: {
        min: Math.min(0, ...data.map((cell) => cell[2]!)),
        max: Math.max(1, ...data.map((cell) => cell[2]!)),
        calculable: true,
        orient: "horizontal",
        bottom: 0,
        left: "center",
      },
    };
  }
  if (view.kind === "sankey") {
    const nodes = [...new Set(rows.flatMap((row) => [cellText(row[view.x!]), cellText(row[view.series!])]))];
    // Cyclic flows cannot be laid out as a Sankey; detect before handing data to the engine.
    const grouped = new Map<string, { source: string; target: string; sum: Decimal }>();
    for (const row of rows) {
      const source = cellText(row[view.x!]),
        target = cellText(row[view.series!]),
        key = JSON.stringify([source, target]);
      const previous = grouped.get(key);
      grouped.set(key, { source, target, sum: (previous?.sum ?? new Decimal(0)).plus(numeric(row, view.y!)) });
    }
    const links = [...grouped.values()].map((link) => ({
      source: link.source,
      target: link.target,
      value: chartNumber(link.sum),
    }));
    const visiting = new Set<string>(),
      visited = new Set<string>();
    const visit = (node: string) => {
      if (visiting.has(node))
        throw new Error("Sankey requires acyclic flows. Use a table for this cyclic relationship.");
      if (visited.has(node)) return;
      visiting.add(node);
      for (const link of links.filter((link) => link.source === node)) visit(link.target);
      visiting.delete(node);
      visited.add(node);
    };
    for (const node of nodes) visit(node);
    if (links.some((link) => link.value < 0)) throw new Error("Flow weights must be nonnegative.");
    return {
      ...base,
      series: [{ type: "sankey", data: nodes.map((name) => ({ name })), links, emphasis: { focus: "adjacency" } }],
    };
  }
  const groups = new Map<string, Map<string, Decimal>>();
  for (const row of rows) {
    const category = cellText(row[view.x!]),
      series = view.series === undefined ? view.title : cellText(row[view.series]);
    let values = groups.get(series);
    if (!values) {
      values = new Map();
      groups.set(series, values);
    }
    values.set(category, (values.get(category) ?? new Decimal(0)).plus(numeric(row, view.y!)));
  }
  if (["pie", "donut", "funnel"].includes(view.kind)) {
    if (groups.size > 1) throw new Error("Use one series for a part-to-whole or funnel view.");
    const data = [...(groups.values().next().value ?? new Map<string, Decimal>())].map(([name, n]) => {
      if (n.isNegative()) throw new Error("Part-to-whole measures must be nonnegative.");
      return { name, value: chartNumber(n) };
    });
    if (data.length && data.every((item) => item.value === 0))
      throw new Error("A part-to-whole chart requires a positive total. Inspect Data for the zero values.");
    return {
      ...base,
      series: [
        view.kind === "funnel"
          ? { type: "funnel", sort: "none", data }
          : { type: "pie", stillShowZeroSum: false, radius: view.kind === "donut" ? ["45%", "75%"] : "75%", data },
      ],
    };
  }
  const categories = [...new Set([...groups.values()].flatMap((values) => [...values.keys()]))];
  return {
    ...base,
    tooltip: { trigger: "axis", renderMode: "richText", confine: true },
    xAxis: { ...axis, type: "category", data: categories },
    yAxis: { ...axis, type: "value" },
    dataZoom: [{ type: "inside", filterMode: "none" }],
    series: [...groups].map(([name, values]) => ({
      name,
      type: view.kind === "bar" || view.kind === "stacked-bar" ? ("bar" as const) : ("line" as const),
      ...(view.kind === "area" ? { areaStyle: {} } : {}),
      ...(view.kind === "stacked-bar" ? { stack: "total" } : {}),
      data: categories.map((key) => (values.has(key) ? chartNumber(values.get(key)!) : null)),
      connectNulls: false,
    })),
  };
}
