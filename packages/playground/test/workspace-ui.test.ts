import { describe, it, strict } from "poku";
import { close, drop, fileTree, pane, panes, validLayout } from "../ui/layout.js";
import { compareGrids, type Grid } from "../ui/result-model.js";

await describe("workspace layout and captured result comparison", async () => {
  await it("copies file views in every split direction and collapses empty groups", () => {
    for (const edge of ["left", "right", "top", "bottom"] as const) {
      const initial = pane("playground/query.ts");
      const split = drop(initial, initial.id, initial.active, edge);
      strict.equal(panes(split.layout).length, 2);
      strict.ok(panes(split.layout).every((item) => item.active === initial.active));
      strict.equal(
        split.layout.kind === "split" && split.layout.axis,
        edge === "left" || edge === "right" ? "horizontal" : "vertical",
      );
      const collapsed = close(split.layout, split.active, initial.active);
      strict.equal(panes(collapsed).length, 1);
      strict.equal(panes(collapsed)[0]?.active, initial.active);
    }
  });
  await it("validates persisted layout and builds real nested file folders", () => {
    const initial = pane("playground/query.ts");
    strict.ok(validLayout(initial, new Set([initial.active])));
    strict.equal(
      validLayout(
        { kind: "split", id: "s", axis: "horizontal", ratio: 0.5, first: initial, second: initial },
        new Set([initial.active]),
      ),
      undefined,
    );
    const tree = fileTree(["playground/deep/q.sql", "src/a.ts", "playground/q.ts"]);
    strict.equal(tree[0]?.name, "playground");
    strict.equal(tree[0]?.children?.[0]?.name, "deep");
  });
  await it("preserves duplicate multiplicity and tagged bigint identity", () => {
    const a: Grid = {
      columns: ["id"],
      rows: [[{ kind: "bigint", value: "9007199254740993" }], [null], [null]],
      truncated: false,
    };
    const b: Grid = { ...a, rows: [[null], [{ kind: "bigint", value: "9007199254740993" }]] };
    const diff = compareGrids(a, b, "multiset");
    strict.equal(diff.equal, 2);
    strict.equal(diff.leftDifferent.size, 1);
    strict.equal(diff.rightDifferent.size, 0);
  });
  await it("distinguishes NULL, missing cells, undefined, and column names", () => {
    const a: Grid = { columns: ["value"], rows: [[null]], truncated: false };
    strict.equal(compareGrids(a, { ...a, rows: [[{ kind: "undefined" }]] }, "ordered").changedCells, 1);
    strict.equal(compareGrids(a, { ...a, rows: [[]] }, "ordered").changedCells, 1);
    strict.equal(compareGrids(a, { ...a, columns: ["renamed"] }, "multiset").equal, 0);
  });
});
