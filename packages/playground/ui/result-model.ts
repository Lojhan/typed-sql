import type { Run, Value } from "./types.js";
export interface Grid {
  columns: string[];
  columnTypes?: (string | null)[];
  rows: Value[][];
  truncated: boolean;
  command?: string;
  affectedRows?: number;
}
const object = (value: Value) =>
  value && typeof value === "object" && value.kind === "object" ? new Map(value.entries) : null;
export function valueText(value: Value): string {
  if (value === null) return "NULL";
  if (typeof value !== "object") return String(value);
  if (value.kind === "undefined") return "undefined";
  if (value.kind === "array") return `[${value.items.map(valueText).join(", ")}]`;
  if (value.kind === "object")
    return `{ ${value.entries.map(([key, item]) => `${key}: ${valueText(item)}`).join(", ")} }`;
  return value.kind === "bigint" ? `${value.value}n` : value.value;
}
export function resultGrid(value: Value): Grid | null {
  const data = object(value),
    columns = data?.get("columns"),
    rows = data?.get("rows");
  if (
    columns &&
    typeof columns === "object" &&
    columns.kind === "array" &&
    rows &&
    typeof rows === "object" &&
    rows.kind === "array"
  )
    return {
      columns: columns.items.map((column, index) => {
        const name = object(column)?.get("name");
        return typeof name === "string" ? name : `column ${index + 1}`;
      }),
      columnTypes: columns.items.map((column) => {
        const value = object(column)?.get("databaseType");
        return typeof value === "string" ? value : null;
      }),
      rows: rows.items.map((row) => (row && typeof row === "object" && row.kind === "array" ? row.items : [])),
      truncated: data?.get("truncated") === true,
      ...(typeof data?.get("command") === "string" ? { command: data.get("command") as string } : {}),
      ...(typeof data?.get("affectedRows") === "number" ? { affectedRows: data.get("affectedRows") as number } : {}),
    };
  if (value && typeof value === "object" && value.kind === "array" && value.items.every((row) => object(row))) {
    const names = [...new Set(value.items.flatMap((row) => [...object(row)!.keys()]))];
    return {
      columns: names,
      rows: value.items.map((row) =>
        names.map((key) => (object(row)!.has(key) ? object(row)!.get(key)! : { kind: "undefined" })),
      ),
      truncated: false,
    };
  }
  return null;
}
export function jsonValue(value: Value): unknown {
  if (!value || typeof value !== "object") return value;
  if (value.kind === "array") return value.items.map(jsonValue);
  if (value.kind === "object") return Object.fromEntries(value.entries.map(([key, item]) => [key, jsonValue(item)]));
  if (value.kind === "date") return value.value;
  if (value.kind === "undefined") return { $type: "undefined" };
  return { $type: value.kind, value: value.value };
}
export function canonical(value: Value): string {
  const normalize = (item: Value): unknown =>
    !item || typeof item !== "object"
      ? item
      : item.kind === "array"
        ? { kind: "array", items: item.items.map(normalize) }
        : item.kind === "object"
          ? {
              kind: "object",
              entries: item.entries
                .toSorted(([a], [b]) => a.localeCompare(b))
                .map(([key, child]) => [key, normalize(child)]),
            }
          : item;
  return JSON.stringify(normalize(value));
}
/** Values align by ordinal; aliases and driver metadata are separate evidence. */
export function compareGrids(left: Grid, right: Grid, mode: "ordered" | "multiset") {
  const sameColumns = JSON.stringify(left.columns) === JSON.stringify(right.columns);
  const knownTypes =
    !!left.columnTypes &&
    !!right.columnTypes &&
    left.columnTypes.every((type) => type !== null) &&
    right.columnTypes.every((type) => type !== null);
  const typeComparison = knownTypes
    ? JSON.stringify(left.columnTypes) === JSON.stringify(right.columnTypes)
      ? "match"
      : "different"
    : "unknown";
  const columnDifferences = new Set<number>();
  for (let index = 0; index < Math.max(left.columns.length, right.columns.length); index++)
    if (
      left.columns[index] !== right.columns[index] ||
      (knownTypes && left.columnTypes?.[index] !== right.columnTypes?.[index])
    )
      columnDifferences.add(index);
  const leftDifferent = new Set<number>(),
    rightDifferent = new Set<number>();
  const leftOnly = new Set<number>(),
    rightOnly = new Set<number>();
  const leftCells = new Map<number, Set<number>>(),
    rightCells = new Map<number, Set<number>>();
  let equal = 0,
    changedCells = 0;
  const key = (row: Value[]) => JSON.stringify(row.map(canonical));
  if (mode === "ordered") {
    for (let row = 0; row < Math.max(left.rows.length, right.rows.length); row++) {
      const a = left.rows[row],
        b = right.rows[row];
      if (a && b && key(a) === key(b)) {
        equal++;
        continue;
      }
      if (a) leftDifferent.add(row);
      if (b) rightDifferent.add(row);
      if (!a) {
        rightOnly.add(row);
        continue;
      }
      if (!b) {
        leftOnly.add(row);
        continue;
      }
      const aCells = new Set<number>(),
        bCells = new Set<number>();
      for (let column = 0; column < Math.max(a.length, b.length); column++) {
        if (column < a.length && column < b.length && canonical(a[column]!) === canonical(b[column]!)) continue;
        changedCells++;
        if (column < a.length) aCells.add(column);
        if (column < b.length) bCells.add(column);
      }
      leftCells.set(row, aCells);
      rightCells.set(row, bCells);
    }
  } else {
    const remaining = new Map<string, number[]>();
    right.rows.forEach((row, index) => {
      const identity = key(row),
        indices = remaining.get(identity) ?? [];
      indices.push(index);
      remaining.set(identity, indices);
    });
    left.rows.forEach((row, index) => {
      const candidates = remaining.get(key(row));
      if (candidates?.length) {
        candidates.pop();
        equal++;
      } else {
        leftDifferent.add(index);
        leftOnly.add(index);
      }
    });
    for (const indices of remaining.values())
      for (const index of indices) {
        rightDifferent.add(index);
        rightOnly.add(index);
      }
  }
  return {
    sameColumns,
    typeComparison,
    columnDifferences,
    equal,
    changedCells,
    leftDifferent,
    rightDifferent,
    leftOnly,
    rightOnly,
    leftCells,
    rightCells,
  };
}
export function totalTime(run: Run): number | null {
  const recorded = run.timings?.totalMs;
  if (typeof recorded === "number" && Number.isFinite(recorded)) return recorded;
  if (!run.finishedAt) return null;
  const duration = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}
export const milliseconds = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ms` : "—";
