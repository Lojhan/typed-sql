import type { SchemaSnapshot } from "@typed-sql/core";
import { parseSchemaSnapshot } from "@typed-sql/schema";

export function schemaBoard(input: SchemaSnapshot) {
  const schema = parseSchemaSnapshot(input);
  if (schema.formatVersion !== 2) {
    return {
      capturedRelationships: false,
      tables: Object.entries(schema.tables).map(([id, table]) => ({
        id,
        name: table.name ?? id,
        namespace: table.schema ?? "",
        kind: "table",
        columns: Object.entries(table.columns).map(([name, column]) => ({
          name,
          databaseType: column.databaseType,
          tsType: column.tsType,
          nullable: column.nullable,
          primary: false,
          unique: false,
        })),
        constraints: [],
        indexes: [],
      })),
      edges: [],
    };
  }
  const tables = Object.entries(schema.relations).map(([id, table]) => ({
    id,
    name: table.name,
    namespace: table.schema ?? "",
    kind: table.kind,
    columns: Object.values(table.columns)
      .sort((a, b) => a.position - b.position)
      .map((column) => ({
        name: column.name,
        databaseType: column.databaseType,
        tsType: column.tsType,
        nullable: column.nullable,
        primary: table.constraints.some((c) => c.kind === "primary-key" && c.columns.includes(column.name)),
        unique: table.constraints.some(
          (c) => c.kind === "unique" && c.columns.length === 1 && c.columns.includes(column.name),
        ),
      })),
    constraints: table.constraints,
    indexes: table.indexes,
  }));
  const edges = Object.entries(schema.relations).flatMap(([id, table]) =>
    table.constraints.flatMap((c) =>
      c.kind === "foreign-key"
        ? [
            {
              id: `${id}:${c.identity}`,
              source: id,
              target: c.referencedRelation,
              columns: c.columns,
              referencedColumns: c.referencedColumns,
              name: c.name ?? c.identity,
              external: !(c.referencedRelation in schema.relations),
            },
          ]
        : [],
    ),
  );
  return { capturedRelationships: true, tables, edges };
}
