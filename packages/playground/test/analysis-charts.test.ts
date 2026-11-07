import { describe, it, strict } from "poku";
import { type AnalysisDataset, type AnalysisView, viewSchema } from "../src/analysis-contract.js";
import { metricComparison } from "../src/analysis-model.js";

// This browser adapter is checked by tsconfig.ui.json. Load it at runtime so
// the server test project does not absorb ECharts' browser-only declaration graph.
const { chartOption } = (await import(new URL("../ui/analysis-chart-option.ts", import.meta.url).href)) as {
  chartOption: (view: AnalysisView, rows: AnalysisDataset["rows"], dark: boolean) => Record<string, unknown>;
};

await describe("declarative chart adapters", async () => {
  for (const kind of [
    "bar",
    "stacked-bar",
    "line",
    "area",
    "scatter",
    "histogram",
    "pie",
    "donut",
    "sunburst",
    "treemap",
    "heatmap",
    "funnel",
    "sankey",
  ] as const) {
    await it(`builds ${kind} from fixed options in both themes`, () => {
      const view = viewSchema.parse({
        id: "chart",
        title: "Users",
        kind,
        x: 0,
        y: 1,
        ...(["sankey", "heatmap"].includes(kind) ? { series: 2 } : {}),
        ...(["sunburst", "treemap"].includes(kind) ? { hierarchy: [0, 2] } : {}),
      });
      const rows =
        kind === "scatter" || kind === "histogram"
          ? [
              [1, 10],
              [2, 20],
            ]
          : [
              ["EU", 10, "A"],
              ["US", 20, "B"],
            ];
      for (const dark of [false, true]) {
        const option = chartOption(view, rows, dark);
        strict.ok(Array.isArray(option.series));
        strict.ok(JSON.stringify(option).includes('"renderMode":"richText"'));
        strict.equal(option.animation, false);
      }
    });
  }
  await it("aggregates duplicate heatmap cells instead of overlaying contradictory values", () => {
    const view = viewSchema.parse({ id: "heat", title: "Heat", kind: "heatmap", x: 0, y: 1, series: 2 });
    const option = chartOption(
      view,
      [
        ["EU", 10, "A"],
        ["EU", 20, "A"],
      ],
      false,
    );
    strict.equal(JSON.stringify(option.series).includes('"data":[[0,0,30]]'), true);
  });
  await it("rejects cyclic Sankey links before invoking the renderer", () => {
    const view = viewSchema.parse({ id: "f", title: "Flow", kind: "sankey", x: 0, y: 1, series: 2 });
    strict.throws(
      () =>
        chartOption(
          view,
          [
            ["A", 1, "B"],
            ["B", 1, "A"],
          ],
          false,
        ),
      /acyclic/u,
    );
  });
  await it("keeps signed deltas exact and explicitly labels a zero baseline", () => {
    const view = viewSchema.parse({ id: "metric", title: "Users", kind: "metric", y: 0, compareTo: 1 });
    strict.deepEqual(metricComparison(view, [["0.10000000000000000001", "0.1"]]), {
      delta: "+0.00000000000000000001",
      percent: "0%",
    });
    strict.deepEqual(metricComparison(view, [[4, 0]]), { delta: "+4", percent: "Unavailable (zero baseline)" });
  });
});
