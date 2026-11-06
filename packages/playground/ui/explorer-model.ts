import type { ExplorerObject, ExplorerValue } from "./explorer-types.js";

export interface InspectionTarget {
  kind: "object" | "migration";
  id: string;
  label: string;
}
export type InspectionTab = `@inspect:${string}`;
export function inspectionTab(target: InspectionTarget): InspectionTab {
  return `@inspect:${encodeURIComponent(JSON.stringify(target))}`;
}
export function inspectionTarget(tab: string): InspectionTarget | undefined {
  if (!tab.startsWith("@inspect:") || tab.length > 16384) return undefined;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(tab.slice(9)));
    if (!value || typeof value !== "object") return undefined;
    const target = value as Partial<InspectionTarget>;
    if (
      (target.kind !== "object" && target.kind !== "migration") ||
      typeof target.id !== "string" ||
      !target.id ||
      typeof target.label !== "string" ||
      !target.label
    )
      return undefined;
    return { kind: target.kind, id: target.id, label: target.label };
  } catch {
    return undefined;
  }
}
export function evidenceText(value: unknown): string {
  return value === undefined ? "Not captured" : JSON.stringify(value, null, 2);
}

export interface ExplorerNode {
  id: string;
  label: string;
  kind: string;
  object?: ExplorerObject;
  children: ExplorerNode[];
}
const groupName = (kind: string) =>
  ({
    column: "Columns",
    index: "Indexes",
    constraint: "Constraints",
    relationship: "Relationships",
    enum: "Enums",
    domain: "Domains",
    routine: "Routines",
    function: "Functions",
    table: "Tables",
    view: "Views",
    namespace: "Namespaces",
  })[kind] ?? `${kind[0]?.toUpperCase() ?? ""}${kind.slice(1)}s`;
/** Build only navigation structure; captured backend objects own every semantic fact. */
export function explorerTree(objects: readonly ExplorerObject[]): ExplorerNode[] {
  const byId = new Map(objects.map((object) => [object.id, object]));
  const children = new Map<string, ExplorerObject[]>();
  for (const object of objects) {
    const parent = object.parentId && byId.has(object.parentId) ? object.parentId : "";
    children.set(parent, [...(children.get(parent) ?? []), object]);
  }
  const rows = (parent: string, ancestors: ReadonlySet<string>): ExplorerNode[] => {
    const groups = new Map<string, ExplorerObject[]>();
    for (const object of children.get(parent) ?? []) {
      if (ancestors.has(object.id)) continue;
      groups.set(object.kind, [...(groups.get(object.kind) ?? []), object]);
    }
    return [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap<ExplorerNode>(([kind, entries]) => {
        const nodes = entries
          .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
          .map((object) => ({
            id: object.id,
            label: object.name,
            kind: object.kind,
            object,
            children: rows(object.id, new Set([...ancestors, object.id])),
          }));
        return kind === "namespace"
          ? nodes
          : [{ id: `group:${parent}:${kind}`, label: groupName(kind), kind: "group", children: nodes }];
      });
  };
  return rows("", new Set());
}

export interface PropertyChange {
  path: string;
  before: ExplorerValue | undefined;
  after: ExplorerValue | undefined;
  change: "added" | "removed" | "changed";
}
/** Compare persisted structural facts; never infer a definition from SQL or a fingerprint. */
export function propertyChanges(before: ExplorerValue | undefined, after: ExplorerValue | undefined): PropertyChange[] {
  const leaves = (value: ExplorerValue | undefined, path = ""): Map<string, ExplorerValue> => {
    if (value === undefined) return new Map();
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length)
      return new Map(
        Object.entries(value).flatMap(([key, item]) => [
          ...leaves(item, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
        ]),
      );
    return new Map([[path || "/", value]]);
  };
  const old = leaves(before),
    next = leaves(after);
  return [...new Set([...old.keys(), ...next.keys()])].sort().flatMap((path) => {
    const a = old.get(path),
      b = next.get(path);
    return JSON.stringify(a) === JSON.stringify(b)
      ? []
      : [
          {
            path,
            before: a,
            after: b,
            change: !old.has(path) ? ("added" as const) : !next.has(path) ? ("removed" as const) : ("changed" as const),
          },
        ];
  });
}

export function objectPresence(object: ExplorerObject | undefined): "removed" | "history" | undefined {
  const value = object?.details;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value.exists === false ? "removed" : value.historyOnly === true ? "history" : undefined;
}
