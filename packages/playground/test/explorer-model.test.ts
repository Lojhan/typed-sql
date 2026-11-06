import { describe, it, strict } from "poku";
import { explorerTree, inspectionTab, inspectionTarget, objectLabel, propertyChanges } from "../ui/explorer-model.js";
import type { ExplorerObject } from "../ui/explorer-types.js";
import { close, drop, isTool, open, pane, panes, title, validLayout } from "../ui/layout.js";

const object = (id: string, kind: string, name: string, parentId?: string): ExplorerObject => ({
  id,
  kind,
  name,
  namespace: "billing",
  ...(parentId ? { parentId } : {}),
  details: { exists: true },
  history: [],
  historyState: "unknown",
});
await describe("workspace evidence inspection navigation", async () => {
  await it("keeps an unqualified namespace navigable without inventing a captured schema name", () => {
    const namespace = { ...object("opaque-unqualified-id", "namespace", ""), namespace: "" };
    const node = explorerTree([namespace])[0];
    strict.equal(node?.label, "Unqualified objects");
    strict.equal(namespace.name, "");
    strict.equal(namespace.namespace, "");
    const target = { kind: "object" as const, id: namespace.id, label: objectLabel(namespace) };
    strict.deepEqual(inspectionTarget(inspectionTab(target)), target);
  });
  await it("preserves opaque schema and migration identities through split, close and persisted layout", () => {
    const target = { kind: "object" as const, id: '["billing","payment/~state"]', label: "payment/~state 😀" };
    const tab = inspectionTab(target);
    strict.deepEqual(inspectionTarget(tab), target);
    strict.equal(title(tab), target.label);
    strict.equal(isTool(tab), true);
    const initial = pane("playground/query.ts");
    const opened = open(initial, initial.id, tab);
    const split = drop(opened, initial.id, tab, "right");
    const restored = validLayout(JSON.parse(JSON.stringify(split.layout)), new Set(["playground/query.ts"]));
    strict.ok(restored);
    if (!restored) throw new Error("Expected persisted inspection split");
    strict.deepEqual(
      panes(restored).map((pane) => pane.active),
      [tab, tab],
    );
    strict.equal(panes(close(restored, split.active, tab)).length, 1);
    strict.equal(inspectionTarget("@inspect:%invalid"), undefined);
    strict.equal(
      inspectionTarget("@inspect:%7B%22kind%22%3A%22file%22%2C%22id%22%3A%22outside%22%2C%22label%22%3A%22x%22%7D"),
      undefined,
    );
    strict.equal(inspectionTarget(inspectionTab({ kind: "migration", id: "001", label: "" })), undefined);
  });
  await it("groups only captured parent-child objects and keeps removed objects available", () => {
    const ns = object("ns", "namespace", "billing"),
      table = object("table", "table", "payments", "ns"),
      column = object("column", "column", "amount", "table"),
      index = { ...object("index", "index", "payments_pending_idx", "table"), details: { exists: false } };
    const roots = explorerTree([index, column, table, ns]);
    strict.equal(roots[0]?.object?.id, "ns");
    const relation = roots[0]?.children.find((group) => group.label === "Tables")?.children[0];
    strict.equal(relation?.object?.id, "table");
    strict.deepEqual(
      relation?.children.map((group) => group.label),
      ["Columns", "Indexes"],
    );
    strict.deepEqual(relation?.children.find((group) => group.label === "Indexes")?.children[0]?.object?.details, {
      exists: false,
    });
    strict.equal(explorerTree([object("orphan", "enum", "state", "missing")])[0]?.children[0]?.object?.id, "orphan");
    strict.deepEqual(
      explorerTree([object("a", "table", "a", "b"), object("b", "table", "b", "a")]),
      [],
      "Malformed parent cycles cannot recurse indefinitely",
    );
  });
  await it("diffs exact captured fields, preserving enum order, null, absence and escaped property paths", () => {
    const before = {
      kind: "enum",
      properties: { labels: ["pending", "paid"], nullable: true, "a/b~c": null, unchanged: "same" },
    };
    const after = {
      kind: "enum",
      properties: { labels: ["pending", "paid", "refunded"], nullable: false, added: 0, unchanged: "same" },
    };
    strict.deepEqual(propertyChanges(before, after), [
      { path: "/properties/added", before: undefined, after: 0, change: "added" },
      { path: "/properties/a~1b~0c", before: null, after: undefined, change: "removed" },
      {
        path: "/properties/labels",
        before: ["pending", "paid"],
        after: ["pending", "paid", "refunded"],
        change: "changed",
      },
      { path: "/properties/nullable", before: true, after: false, change: "changed" },
    ]);
    strict.deepEqual(propertyChanges(undefined, { exists: false }), [
      { path: "/exists", before: undefined, after: false, change: "added" },
    ]);
    strict.deepEqual(propertyChanges({ same: 1 }, { same: 1 }), []);
  });
});
