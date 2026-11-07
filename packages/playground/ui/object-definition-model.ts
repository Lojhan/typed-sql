import { objectPresence } from "./explorer-model.js";
import type { ExplorerCatalog, ExplorerObject, ExplorerValue } from "./explorer-types.js";
export function capturedFields(value: ExplorerValue | undefined): Record<string, ExplorerValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
export function capturedNames(value: ExplorerValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}
export const isRelation = (object: ExplorerObject) =>
  ["table", "view", "materialized-view", "foreign-table", "virtual-table", "relation"].includes(object.kind);
export function objectChildren(object: ExplorerObject, catalog: ExplorerCatalog): ExplorerObject[] {
  return catalog.schema.objects
    .filter((item) => item.parentId === object.id)
    .toSorted((a, b) => {
      const x = capturedFields(a.details).position,
        y = capturedFields(b.details).position;
      return typeof x === "number" || typeof y === "number"
        ? (typeof x === "number" ? x : Infinity) - (typeof y === "number" ? y : Infinity)
        : a.name.localeCompare(b.name);
    });
}
export interface CapturedRelationship {
  object: ExplorerObject;
  source: ExplorerObject | undefined;
  target: ExplorerObject | undefined;
  columns: string[] | undefined;
  referencedColumns: string[] | undefined;
  referencedRelation: string | undefined;
}
export function capturedRelationship(object: ExplorerObject, catalog: ExplorerCatalog): CapturedRelationship {
  const fields = capturedFields(object.details);
  const edge = catalog.schema.links.find((link) => link.kind === "foreign-key" && link.id === object.id);
  return {
    object,
    source: catalog.schema.objects.find((item) => item.id === object.parentId),
    target: edge ? catalog.schema.objects.find((item) => item.id === edge.target) : undefined,
    columns: capturedNames(fields.columns),
    referencedColumns: capturedNames(fields.referencedColumns),
    referencedRelation: typeof fields.referencedRelation === "string" ? fields.referencedRelation : undefined,
  };
}
export function relationDefinition(object: ExplorerObject, catalog: ExplorerCatalog) {
  const all = objectChildren(object, catalog),
    current = all.filter((item) => !objectPresence(item));
  const constraints = current.filter((item) => item.kind === "constraint");
  const outgoing = current
    .filter((item) => item.kind === "relationship")
    .map((item) => capturedRelationship(item, catalog));
  const incoming = catalog.schema.links
    .filter((link) => link.kind === "foreign-key" && link.target === object.id)
    .flatMap((link) => {
      const relationship = catalog.schema.objects.find((item) => item.id === link.id && item.kind === "relationship");
      return relationship && !objectPresence(relationship) ? [capturedRelationship(relationship, catalog)] : [];
    });
  return {
    columns: current.filter((item) => item.kind === "column"),
    indexes: current.filter((item) => item.kind === "index"),
    constraints,
    outgoing,
    incoming,
    historical: all.filter((item) => !!objectPresence(item)),
  };
}
export function columnKeys(column: ExplorerObject, constraints: readonly ExplorerObject[]): string[] {
  return [
    ...new Set(
      constraints.flatMap((constraint) => {
        const fields = capturedFields(constraint.details);
        if (!capturedNames(fields.columns)?.includes(column.name)) return [];
        return fields.kind === "primary-key"
          ? ["Primary key"]
          : fields.kind === "foreign-key"
            ? ["Foreign key"]
            : fields.kind === "unique"
              ? ["Unique key"]
              : [];
      }),
    ),
  ];
}
export function capturedNullability(value: ExplorerValue | undefined): string {
  return value === true ? "Nullable" : value === false ? "Not null" : "Unknown";
}
export function indexColumns(value: ExplorerValue | undefined): string {
  if (!Array.isArray(value)) return "Not captured";
  if (!value.length) return "None";
  return value
    .map((item) => {
      const fields = capturedFields(item);
      const column =
        typeof fields.column === "string"
          ? fields.column
          : typeof fields.expressionHash === "string"
            ? "Expression (definition not captured)"
            : "Not captured";
      return [
        column,
        fields.descending === true ? "DESC" : fields.descending === false ? "ASC" : undefined,
        fields.nulls === "first" ? "NULLS FIRST" : fields.nulls === "last" ? "NULLS LAST" : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    })
    .join(", ");
}
