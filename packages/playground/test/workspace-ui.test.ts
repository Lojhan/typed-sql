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
    const empty = fileTree(["playground/nested/query.sql"], ["playground/empty", "playground/nested"]);
    strict.equal(empty[0]?.children.find((node) => node.name === "empty")?.file, false);
    strict.deepEqual(empty[0]?.children.find((node) => node.name === "empty")?.children, []);
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
    strict.equal(compareGrids(a, { ...a, columns: ["renamed"] }, "multiset").equal, 1);
  });
  await it("separates alias/type metadata from positional values and marks only changed cells", () => {
    const a: Grid = {
      columns: ["id", "name"],
      columnTypes: ["oid:20", "oid:25"],
      rows: [
        [1, "Alice"],
        [2, "Béatrice"],
        [3, "Review account 3"],
        [4, "Review account 4"],
      ],
      truncated: false,
    };
    const b: Grid = {
      ...a,
      columns: ["account_id", "display_name"],
      columnTypes: ["oid:23", "oid:25"],
      rows: [
        [1, "Alicea"],
        [2, "Béatrice"],
        [3, "Review account 3a"],
        [4, "Review account 4"],
      ],
    };
    const diff = compareGrids(a, b, "ordered");
    strict.equal(diff.sameColumns, false);
    strict.equal(diff.typeComparison, "different");
    strict.equal(diff.equal, 2);
    strict.equal(diff.changedCells, 2);
    strict.deepEqual([...(diff.leftCells.get(0) ?? [])], [1]);
    strict.deepEqual([...(diff.rightCells.get(2) ?? [])], [1]);
    strict.equal(diff.leftCells.has(1), false);
    strict.equal(diff.leftCells.has(3), false);
    strict.equal(diff.leftOnly.size, 0);
    strict.equal(diff.rightOnly.size, 0);
    const aliasOnly = compareGrids(a, { ...a, columns: b.columns }, "ordered");
    strict.equal(aliasOnly.equal, 4);
    strict.equal(aliasOnly.changedCells, 0);
    strict.equal(aliasOnly.leftDifferent.size, 0);
    const multiset = compareGrids(a, { ...a, columns: b.columns, rows: a.rows.toReversed() }, "multiset");
    strict.equal(multiset.equal, 4);
    strict.equal(multiset.leftOnly.size, 0);
    const missing = compareGrids(a, { ...b, rows: b.rows.slice(0, 3) }, "ordered");
    strict.deepEqual([...missing.leftOnly], [3]);
  });
});
