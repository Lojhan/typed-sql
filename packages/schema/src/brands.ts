import type { SchemaSnapshot, SchemaSnapshotV1, SchemaSnapshotV2 } from "./model.js";
import { defineSchemaSnapshotV2, schemaSnapshotV2Envelope } from "./v2/codec.js";

export interface SchemaBrands {
  /** Relation identity -> column name -> application brand name. */
  readonly columns?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Domain type identity -> application brand name. */
  readonly domains?: Readonly<Record<string, string>>;
}

function brandedType(type: string, name: string): string {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 200 ||
    [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new TypeError("A schema brand requires a non-empty name of at most 200 printable characters");
  if (!["string", "number", "bigint"].includes(type))
    throw new TypeError("Schema brands require a precise string, number or bigint scalar");
  return `import("@typed-sql/core").Brand<${type}, ${JSON.stringify(name)}>`;
}

/** Apply explicit nominal identities to validated scalar columns/domains before generating a snapshot. */
export function withSchemaBrands(snapshot: SchemaSnapshotV1, brands: SchemaBrands): SchemaSnapshotV1;
export function withSchemaBrands(snapshot: SchemaSnapshotV2, brands: SchemaBrands): SchemaSnapshotV2;
export function withSchemaBrands(snapshot: SchemaSnapshot, brands: SchemaBrands): SchemaSnapshot;
export function withSchemaBrands(snapshot: SchemaSnapshot, brands: SchemaBrands): SchemaSnapshot {
  if (snapshot.formatVersion === 1) {
    const domains = { ...snapshot.domains };
    for (const [identity, name] of Object.entries(brands.domains ?? {})) {
      const domain = domains[identity];
      if (domain === undefined) throw new TypeError(`Unknown domain identity ${identity}`);
      domains[identity] = { ...domain, tsType: brandedType(domain.tsType, name) };
    }
    for (const identity of Object.keys(brands.columns ?? {}))
      if (snapshot.tables[identity] === undefined) throw new TypeError(`Unknown relation identity ${identity}`);
    const tables = Object.fromEntries(
      Object.entries(snapshot.tables).map(([identity, table]) => {
        const columns = { ...table.columns };
        for (const [name, column] of Object.entries(columns))
          if (brands.domains?.[column.databaseType] !== undefined)
            columns[name] = { ...column, tsType: domains[column.databaseType]!.tsType };
        for (const [name, brand] of Object.entries(brands.columns?.[identity] ?? {})) {
          const column = columns[name];
          if (column === undefined) throw new TypeError(`Unknown column ${identity}.${name}`);
          if (column.jsonDeclaration !== undefined) throw new TypeError("JSON declarations cannot carry scalar brands");
          columns[name] = { ...column, tsType: brandedType(column.tsType, brand) };
        }
        return [identity, { ...table, columns }];
      }),
    );
    const { metadata: _metadata, ...base } = snapshot as SchemaSnapshotV1 & { readonly metadata?: unknown };
    return { ...base, tables, ...(snapshot.domains === undefined ? {} : { domains }) };
  }
  const original = snapshot;
  const types = { ...original.types };
  for (const [identity, name] of Object.entries(brands.domains ?? {})) {
    const domain = types[identity];
    if (domain?.kind !== "domain") throw new TypeError(`Unknown domain identity ${identity}`);
    types[identity] = { ...domain, tsType: brandedType(domain.tsType, name) };
  }
  const relations = { ...original.relations };
  for (const identity of Object.keys(brands.columns ?? {}))
    if (relations[identity] === undefined) throw new TypeError(`Unknown relation identity ${identity}`);
  for (const [identity, relation] of Object.entries(relations)) {
    const columns = { ...relation.columns };
    for (const [name, column] of Object.entries(columns)) {
      const domain = types[column.typeIdentity];
      if (brands.domains?.[column.typeIdentity] !== undefined && domain !== undefined)
        columns[name] = { ...column, tsType: domain.tsType };
    }
    for (const [name, brand] of Object.entries(brands.columns?.[identity] ?? {})) {
      const column = columns[name];
      if (column === undefined) throw new TypeError(`Unknown column ${identity}.${name}`);
      if (column.jsonDeclaration !== undefined) throw new TypeError("JSON declarations cannot carry scalar brands");
      columns[name] = { ...column, tsType: brandedType(column.tsType, brand) };
    }
    relations[identity] = { ...relation, columns };
  }
  // Rebuild transitional views and discard metadata describing the unbranded schema.
  const { metadata: _metadata, ...envelope } = schemaSnapshotV2Envelope(original);
  return defineSchemaSnapshotV2({ ...envelope, types, relations });
}
