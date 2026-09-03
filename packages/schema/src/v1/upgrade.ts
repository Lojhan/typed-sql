import { createHash } from "node:crypto";
import { defineDialectServerEvidence } from "@typed-sql/core";
import type { RelationSnapshot, RoutineSnapshot, SchemaSnapshotV2, TypeSnapshot } from "../v2/model.js";
import { SCHEMA_FORMAT_VERSION } from "../v2/model.js";
import type { SchemaSnapshotV1 } from "./model.js";

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function splitQualified(key: string): { readonly schema?: string; readonly name: string } {
  const dot = key.lastIndexOf(".");
  return dot === -1 ? { name: key } : { schema: key.slice(0, dot), name: key.slice(dot + 1) };
}

/** Conservatively projects v1 evidence into v2. Missing v1 facts remain unknown. */
export function upgradeSchemaSnapshotV1(snapshot: SchemaSnapshotV1): SchemaSnapshotV2 {
  const server =
    snapshot.server ??
    defineDialectServerEvidence({
      product: snapshot.dialect,
      version: snapshot.version ?? "unknown",
      versionKey: snapshot.version ?? "unknown",
      features: [],
      settings: {},
    });
  const namespaceNames = new Set<string>();
  const relations: Record<string, RelationSnapshot> = {};
  for (const [key, table] of Object.entries(snapshot.tables)) {
    if (table.schema !== undefined) namespaceNames.add(table.schema);
    relations[key] = {
      ...(table.schema === undefined ? {} : { schema: table.schema }),
      name: table.name,
      kind: "table",
      columns: Object.fromEntries(
        Object.entries(table.columns).map(([columnKey, column], position) => [
          columnKey,
          {
            name: column.name,
            position,
            databaseType: column.databaseType,
            typeIdentity: column.databaseType,
            tsType: column.tsType,
            nullable: column.nullable,
            nullabilitySource: "unknown" as const,
            default: column.defaultExpression === undefined ? ("unknown" as const) : ("present" as const),
            ...(column.defaultExpression === undefined
              ? {}
              : { defaultExpressionHash: digest(column.defaultExpression) }),
            generated: "none" as const,
            identity: "unknown" as const,
            ...(column.array ? { dimensions: [] } : {}),
            classification: "normal" as const,
            insertable: "unknown" as const,
            updatable: "unknown" as const,
          },
        ]),
      ),
      constraints: [],
      indexes: [],
      capabilities: { evidenceComplete: false },
    };
  }
  const types: Record<string, TypeSnapshot> = {};
  for (const [key, labels] of Object.entries(snapshot.enums ?? {})) {
    const qualified = splitQualified(key);
    if (qualified.schema !== undefined) namespaceNames.add(qualified.schema);
    types[key] = {
      kind: "enum",
      ...qualified,
      identity: key,
      databaseType: key,
      tsType: labels.map((label) => JSON.stringify(label)).join(" | ") || "string",
      labels,
    };
  }
  for (const [key, domain] of Object.entries(snapshot.domains ?? {})) {
    const qualified = splitQualified(key);
    if (qualified.schema !== undefined) namespaceNames.add(qualified.schema);
    types[key] = {
      kind: "domain",
      ...qualified,
      name: domain.name,
      identity: key,
      databaseType: domain.databaseType,
      tsType: domain.tsType,
      baseTypeIdentity: domain.databaseType,
      nullable: domain.nullable,
      checks: [],
    };
  }
  const routines: Record<string, RoutineSnapshot[]> = {};
  for (const [key, fn] of Object.entries(snapshot.functions ?? {})) {
    if (fn.schema !== undefined) namespaceNames.add(fn.schema);
    const name = `${fn.schema === undefined ? "" : `${fn.schema}.`}${fn.name}`;
    const overload: RoutineSnapshot = {
      name: fn.name,
      ...(fn.schema === undefined ? {} : { schema: fn.schema }),
      identity: key,
      kind: "function",
      arguments: fn.argumentTypes.map((databaseType) => ({
        mode: "in",
        typeIdentity: databaseType,
        databaseType,
        tsType: "unknown",
        default: "unknown",
      })),
      result: {
        kind: fn.setReturning ? "set" : "scalar",
        typeIdentity: fn.databaseReturnType ?? fn.returnType,
        databaseType: fn.databaseReturnType ?? fn.returnType,
        tsType: fn.returnType,
        nullable: fn.nullable,
      },
      volatility: fn.volatility ?? "unknown",
      deterministic: "unknown",
      dataAccess: "unknown",
      nullInput: "unknown",
    };
    const overloads = routines[name];
    if (overloads === undefined) routines[name] = [overload];
    else overloads.push(overload);
  }
  const namespaces = Object.fromEntries(
    [...namespaceNames].sort().map((name) => [name, { name, kind: "schema" as const }]),
  );
  return {
    formatVersion: SCHEMA_FORMAT_VERSION,
    dialect: snapshot.dialect,
    dialectVersion: snapshot.dialectVersion ?? "unknown",
    server,
    namespaces,
    types,
    relations,
    routines: Object.fromEntries(
      Object.entries(routines)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, overloads]) => [key, overloads.sort((left, right) => left.identity.localeCompare(right.identity))]),
    ),
    version: server.version,
    tables: snapshot.tables,
    ...(snapshot.enums === undefined ? {} : { enums: snapshot.enums }),
    ...(snapshot.domains === undefined ? {} : { domains: snapshot.domains }),
    ...(snapshot.functions === undefined ? {} : { functions: snapshot.functions }),
  };
}
