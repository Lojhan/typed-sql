import { Decimal as DecimalBase } from "decimal.js";

const Decimal = DecimalBase.clone({ precision: 1024 });
type Decimal = DecimalBase;

import type { AnalysisDataset, AnalysisFilter, AnalysisView, FilterValues } from "./analysis-contract.js";
import type { WireValue } from "./value-types.js";

export function cellText(value: WireValue | undefined): string {
  if (value === null) return "NULL";
  if (value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if ("value" in value)
    return value.kind === "bytes" ? `[bytes: ${value.value.length} encoded characters]` : value.value;
  if (value.kind === "undefined") return "";
  return JSON.stringify(value);
}
export function decimalValue(value: WireValue | undefined): Decimal | null {
  const text = cellText(value);
  if (text.replace(/[^0-9]/gu, "").length > 1000) return null;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(text)) return null;
  try {
    const number = new Decimal(text);
    return number.isFinite() ? number : null;
  } catch {
    return null;
  }
}
export function filteredRows(dataset: AnalysisDataset, filters: readonly AnalysisFilter[], values: FilterValues) {
  return dataset.rows.filter((row) =>
    filters.every((filter) => {
      if (filter.mode !== "captured") return true;
      const value = values[filter.id];
      if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) return true;
      const cell = cellText(row[filter.column]);
      if (Array.isArray(value)) return value.includes(cell);
      if (filter.kind === "toggle" && value === false) return true;
      if (filter.kind === "date" && filter.operator === "equals") return cell.slice(0, 10) === String(value);
      if (filter.operator === "contains") return cell.toLocaleLowerCase().includes(String(value).toLocaleLowerCase());
      if (filter.operator === "gte" || filter.operator === "lte") {
        if (filter.kind === "date") {
          const actual = Date.parse(cell),
            expected = Date.parse(
              String(value) +
                (String(value).length === 10 ? (filter.operator === "lte" ? "T23:59:59.999Z" : "T00:00:00.000Z") : ""),
            );
          return (
            Number.isFinite(actual) &&
            Number.isFinite(expected) &&
            (filter.operator === "gte" ? actual >= expected : actual <= expected)
          );
        }
        const actual = decimalValue(row[filter.column]),
          expected = decimalValue(String(value));
        return (
          actual !== null &&
          expected !== null &&
          (filter.operator === "gte" ? actual.gte(expected) : actual.lte(expected))
        );
      }
      return cell === String(value);
    }),
  );
}
export function metricValue(view: AnalysisView, rows: AnalysisDataset["rows"]): string {
  if (view.aggregate === "count") return String(rows.length);
  if (!rows.length) return "—";
  if (view.aggregate === "first") return cellText(rows[0]?.[view.y!]);
  let sum = new Decimal(0),
    count = 0;
  for (const row of rows) {
    const value = decimalValue(row[view.y!]);
    if (value) {
      sum = sum.plus(value);
      count++;
    } else if (row[view.y!] !== null)
      throw new Error("The metric measure contains nonnumeric values. Choose a numeric column or first-value metric.");
  }
  return count ? sum.toFixed() : "—";
}
export function chartNumber(value: Decimal): number {
  if (value.abs().gt(Number.MAX_SAFE_INTEGER))
    throw new Error("This measure exceeds safe chart precision. Inspect the exact values in Data or use a metric.");
  const result = value.toNumber();
  if (!value.isZero() && result === 0)
    throw new Error("This measure is too small for chart precision; inspect Data instead.");
  return result;
}
export function metricComparison(view: AnalysisView, rows: AnalysisDataset["rows"]) {
  if (view.compareTo === undefined) return null;
  const current = decimalValue(metricValue(view, rows)),
    previous = decimalValue(metricValue({ ...view, y: view.compareTo }, rows));
  if (!current || !previous) return null;
  const delta = current.minus(previous);
  return {
    delta: `${delta.isPositive() ? "+" : ""}${delta.toFixed()}`,
    percent: previous.isZero()
      ? "Unavailable (zero baseline)"
      : `${delta.div(previous.abs()).times(100).toDecimalPlaces(2).toFixed()}%`,
  };
}
export interface HierarchyNode {
  name: string;
  value: number;
  exact: string;
  children?: HierarchyNode[];
}
export function hierarchyData(view: AnalysisView, rows: AnalysisDataset["rows"]): HierarchyNode[] {
  interface Node {
    name: string;
    sum: Decimal;
    children: Map<string, Node>;
  }
  const root = new Map<string, Node>();
  for (const row of rows) {
    const value = decimalValue(row[view.y!]);
    if (!value || value.isNegative())
      throw new Error("Hierarchy measures must be nonnegative numbers; aggregate at leaf level in SQL.");
    let level = root;
    for (const field of view.hierarchy ?? []) {
      const name = cellText(row[field]);
      let node = level.get(name);
      if (!node) {
        node = { name, sum: new Decimal(0), children: new Map() };
        level.set(name, node);
      }
      node.sum = node.sum.plus(value);
      level = node.children;
    }
  }
  const convert = (nodes: Map<string, Node>): HierarchyNode[] =>
    [...nodes.values()].map((node) => ({
      name: node.name,
      value: chartNumber(node.sum),
      exact: node.sum.toFixed(),
      ...(node.children.size ? { children: convert(node.children) } : {}),
    }));
  const result = convert(root);
  if (result.length && result.every((node) => node.value === 0))
    throw new Error("Hierarchy requires a positive total; inspect Data for the zero values.");
  return result;
}
export function capturedCsv(columns: readonly string[], rows: AnalysisDataset["rows"]) {
  // Prevent spreadsheet formulas while preserving exact values in JSON exports.
  const quote = (text: string) => `"${(/^[=+\-@\t\r]/u.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`;
  return [columns, ...rows.map((row) => row.map(cellText))].map((row) => row.map(quote).join(",")).join("\r\n");
}
