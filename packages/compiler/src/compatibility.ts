import { createHash } from "node:crypto";
import type { SchemaSnapshot as CoreSchemaSnapshot, QueryDependency, SourceRange } from "@typed-sql/core";
import {
  calculateSchemaHash,
  parseSchemaSnapshot,
  type RelationSnapshot,
  type RoutineSnapshot,
  type SchemaSnapshot,
  serializeSchemaSnapshot,
  type TypeSnapshot,
} from "@typed-sql/schema";
import { canonicalize, compareText } from "./artifact-serialization.js";
import type { QueryManifest, QueryManifestLocation, QueryManifestVariant } from "./manifest.js";
import { parseQueryManifest, serializeQueryManifest } from "./manifest.js";

export const SCHEMA_COMPATIBILITY_FORMAT_VERSION = 1 as const;
export const SCHEMA_COMPATIBILITY_ANALYZER_VERSION = "typed-sql-v1" as const;

export type DeploymentDirection = "before-app-after-database" | "after-app-before-database";
export type CompatibilityClassification =
  | "compatible"
  | "deployment-order-sensitive"
  | "source-breaking"
  | "runtime-breaking"
  | "unknown";
export type CompatibilitySeverity = "info" | "warning" | "error";
export type SchemaCompatibilityChangeKind =
  | "relation-added"
  | "relation-removed"
  | "column-added"
  | "column-removed"
  | "column-database-type"
  | "column-typescript-type"
  | "column-nullability"
  | "column-array"
  | "column-default"
  | "enum-added"
  | "enum-removed"
  | "enum-values"
  | "domain-added"
  | "domain-removed"
  | "domain-database-type"
  | "domain-typescript-type"
  | "domain-nullability"
  | "function-added"
  | "function-removed"
  | "function-return-type"
  | "function-nullability"
  | "function-set-returning"
  | "function-volatility"
  | "namespace-added"
  | "namespace-removed"
  | "namespace-definition"
  | "relation-definition"
  | "column-structure"
  | "constraint-added"
  | "constraint-removed"
  | "constraint-definition"
  | "index-added"
  | "index-removed"
  | "index-definition"
  | "type-added"
  | "type-removed"
  | "type-definition"
  | "routine-added"
  | "routine-removed"
  | "routine-definition"
  | "server-evidence"
  | "extension-definition"
  | "dialect-version"
  | "server-version"
  | "query-contract";

export interface SchemaCompatibilityTarget {
  readonly kind:
    | "schema"
    | "namespace"
    | "relation"
    | "column"
    | "constraint"
    | "index"
    | "type"
    | "enum"
    | "domain"
    | "routine"
    | "function"
    | "extension"
    | "query";
  readonly key: string;
  readonly name: string;
  readonly schema?: string;
  readonly parent?: string;
}

export type CompatibilityEvidenceValue = string | boolean | null | readonly string[];
export type CompatibilityEvidence = Readonly<Record<string, CompatibilityEvidenceValue>>;

export interface SchemaCompatibilityChange {
  readonly id: string;
  readonly kind: SchemaCompatibilityChangeKind;
  readonly target: SchemaCompatibilityTarget;
  readonly before?: CompatibilityEvidence;
  readonly after?: CompatibilityEvidence;
}

export interface CompatibilityQueryReference {
  readonly queryId: string;
  readonly variantFingerprint: string;
  readonly source: QueryManifestLocation;
  readonly dependencyRange?: SourceRange;
}

export interface SchemaCompatibilityAssessment {
  readonly direction: DeploymentDirection;
  readonly changeId?: string;
  readonly classification: CompatibilityClassification;
  readonly severity: CompatibilitySeverity;
  readonly reason: string;
  readonly queries: readonly CompatibilityQueryReference[];
}

export interface SchemaCompatibilityReport {
  readonly formatVersion: typeof SCHEMA_COMPATIBILITY_FORMAT_VERSION;
  readonly analyzerVersion: typeof SCHEMA_COMPATIBILITY_ANALYZER_VERSION;
  readonly dialect: string;
  readonly before: {
    readonly schemaHash: string;
    readonly manifestHash: string;
    readonly schemaFormat?: 1 | 2;
    readonly version?: string;
  };
  readonly after: {
    readonly schemaHash: string;
    readonly manifestHash: string;
    readonly schemaFormat?: 1 | 2;
    readonly version?: string;
  };
  readonly changes: readonly SchemaCompatibilityChange[];
  readonly assessments: readonly SchemaCompatibilityAssessment[];
  readonly summary: Readonly<Record<CompatibilitySeverity, number>>;
}

export interface AnalyzeSchemaCompatibilityOptions {
  readonly before: CoreSchemaSnapshot;
  readonly after: CoreSchemaSnapshot;
  readonly beforeManifest: QueryManifest;
  readonly afterManifest: QueryManifest;
}

interface InternalChange {
  readonly change: SchemaCompatibilityChange;
  readonly keys: readonly string[];
  readonly relationWriteKey?: string;
  readonly addedMandatoryColumn?: boolean;
  readonly removedMandatoryColumn?: boolean;
  readonly queryReferences?: Readonly<Record<DeploymentDirection, CompatibilityQueryReference>>;
}

interface ManifestReferences {
  readonly byKey: ReadonlyMap<string, readonly CompatibilityQueryReference[]>;
  readonly unknown: readonly CompatibilityQueryReference[];
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const relationKey = (key: string) => `relation:${key}`;
const relationWriteKey = (key: string) => `relation-write:${key}`;
const columnKey = (table: string, column: string) => `column:${table}.${column}`;
const functionKey = (key: string) => `function:${key}`;
const functionNameKey = (schema: string | undefined, name: string) => `function-name:${schema ?? ""}.${name}`;
const typeKey = (kind: "enum" | "domain", key: string) => `type:${kind}:${key}`;
const structuralTypeKey = (key: string) => `type:${key}`;
const routineKey = (schema: string | undefined, name: string) => `routine:${schema ?? ""}.${name}`;
const changeKinds = new Set<SchemaCompatibilityChangeKind>([
  "relation-added",
  "relation-removed",
  "column-added",
  "column-removed",
  "column-database-type",
  "column-typescript-type",
  "column-nullability",
  "column-array",
  "column-default",
  "enum-added",
  "enum-removed",
  "enum-values",
  "domain-added",
  "domain-removed",
  "domain-database-type",
  "domain-typescript-type",
  "domain-nullability",
  "function-added",
  "function-removed",
  "function-return-type",
  "function-nullability",
  "function-set-returning",
  "function-volatility",
  "namespace-added",
  "namespace-removed",
  "namespace-definition",
  "relation-definition",
  "column-structure",
  "constraint-added",
  "constraint-removed",
  "constraint-definition",
  "index-added",
  "index-removed",
  "index-definition",
  "type-added",
  "type-removed",
  "type-definition",
  "routine-added",
  "routine-removed",
  "routine-definition",
  "server-evidence",
  "extension-definition",
  "dialect-version",
  "server-version",
  "query-contract",
]);
const targetKinds = new Set<SchemaCompatibilityTarget["kind"]>([
  "schema",
  "namespace",
  "relation",
  "column",
  "constraint",
  "index",
  "type",
  "enum",
  "domain",
  "routine",
  "function",
  "extension",
  "query",
]);
const directions = new Set<DeploymentDirection>(["before-app-after-database", "after-app-before-database"]);
const classifications = new Set<CompatibilityClassification>([
  "compatible",
  "deployment-order-sensitive",
  "source-breaking",
  "runtime-breaking",
  "unknown",
]);
const severities = new Set<CompatibilitySeverity>(["info", "warning", "error"]);

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, description: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${description} must be a non-empty string`);
}

function assertOptionalString(value: unknown, description: string): void {
  if (value !== undefined) assertNonEmptyString(value, description);
}

function assertHash(value: unknown, description: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f\d]{64}$/u.test(value)) {
    throw new TypeError(`${description} must be a sha256 fingerprint`);
  }
}

function assertDigest(value: unknown, description: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f\d]{64}$/u.test(value)) {
    throw new TypeError(`${description} must be a sha256 digest`);
  }
}

function assertRange(value: unknown, description: string): asserts value is SourceRange {
  if (
    !record(value) ||
    !Number.isSafeInteger(value.start) ||
    (value.start as number) < 0 ||
    !Number.isSafeInteger(value.end) ||
    (value.end as number) < (value.start as number) ||
    !Number.isSafeInteger(value.line) ||
    (value.line as number) < 1 ||
    !Number.isSafeInteger(value.column) ||
    (value.column as number) < 1
  ) {
    throw new TypeError(`${description} must contain a valid source range`);
  }
}

function assertLocation(value: unknown, description: string): asserts value is QueryManifestLocation {
  if (!record(value)) throw new TypeError(`${description} must be an object`);
  assertNonEmptyString(value.file, `${description}.file`);
  if (/^(?:\/|\\|[A-Za-z]:[\\/])/u.test(value.file) || value.file.includes("\0")) {
    throw new TypeError(`${description}.file must be a portable relative path`);
  }
  assertRange(value.range, `${description}.range`);
}

function assertEvidence(value: unknown, description: string): asserts value is CompatibilityEvidence {
  if (!record(value)) throw new TypeError(`${description} must be an object`);
  for (const item of Object.values(value)) {
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "boolean" &&
      !(Array.isArray(item) && item.every((entry) => typeof entry === "string"))
    ) {
      throw new TypeError(`${description} contains an unsupported evidence value`);
    }
  }
}

function assertQueryReference(value: unknown, description: string): asserts value is CompatibilityQueryReference {
  if (!record(value)) throw new TypeError(`${description} must be an object`);
  assertHash(value.queryId, `${description}.queryId`);
  assertHash(value.variantFingerprint, `${description}.variantFingerprint`);
  assertLocation(value.source, `${description}.source`);
  if (value.dependencyRange !== undefined) assertRange(value.dependencyRange, `${description}.dependencyRange`);
}

function targetIdentity(target: SchemaCompatibilityTarget): string {
  return `${target.kind}\0${target.key}\0${target.schema ?? ""}\0${target.parent ?? ""}\0${target.name}`;
}

function change(
  kind: SchemaCompatibilityChangeKind,
  target: SchemaCompatibilityTarget,
  before: CompatibilityEvidence | undefined,
  after: CompatibilityEvidence | undefined,
): SchemaCompatibilityChange {
  const identity = JSON.stringify(canonicalize({ kind, target, before, after }));
  return {
    id: `sha256:${sha256(identity)}`,
    kind,
    target,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
}

function relationTarget(key: string, table: SchemaSnapshot["tables"][string]): SchemaCompatibilityTarget {
  return {
    kind: "relation",
    key,
    name: table.name,
    ...(table.schema === undefined ? {} : { schema: table.schema }),
  };
}

function columnTarget(
  tableKey: string,
  table: SchemaSnapshot["tables"][string],
  name: string,
): SchemaCompatibilityTarget {
  return {
    kind: "column",
    key: `${tableKey}.${name}`,
    name,
    parent: tableKey,
    ...(table.schema === undefined ? {} : { schema: table.schema }),
  };
}

function typeTarget(
  kind: "enum" | "domain",
  key: string,
  name = key.split(".").at(-1) ?? key,
): SchemaCompatibilityTarget {
  const dot = key.lastIndexOf(".");
  return {
    kind,
    key,
    name,
    ...(dot === -1 ? {} : { schema: key.slice(0, dot) }),
  };
}

function functionTarget(
  key: string,
  value: NonNullable<SchemaSnapshot["functions"]>[string],
): SchemaCompatibilityTarget {
  return {
    kind: "function",
    key,
    name: value.name,
    ...(value.schema === undefined ? {} : { schema: value.schema }),
  };
}

function defaultEvidence(value: string | undefined): CompatibilityEvidence {
  return value === undefined ? { present: false, fingerprint: null } : { present: true, fingerprint: sha256(value) };
}

function enumChanges(before: SchemaSnapshot, after: SchemaSnapshot): InternalChange[] {
  const output: InternalChange[] = [];
  const keys = [...new Set([...Object.keys(before.enums ?? {}), ...Object.keys(after.enums ?? {})])].sort(compareText);
  for (const key of keys) {
    const left = before.enums?.[key];
    const right = after.enums?.[key];
    const target = typeTarget("enum", key);
    if (left === undefined && right !== undefined) {
      const item = change("enum-added", target, undefined, { values: right });
      output.push({ change: item, keys: [typeKey("enum", key)] });
    } else if (left !== undefined && right === undefined) {
      const item = change("enum-removed", target, { values: left }, undefined);
      output.push({ change: item, keys: [typeKey("enum", key)] });
    } else if (left !== undefined && right !== undefined && JSON.stringify(left) !== JSON.stringify(right)) {
      const item = change("enum-values", target, { values: left }, { values: right });
      output.push({ change: item, keys: [typeKey("enum", key)] });
    }
  }
  return output;
}

function domainChanges(before: SchemaSnapshot, after: SchemaSnapshot): InternalChange[] {
  const output: InternalChange[] = [];
  const keys = [...new Set([...Object.keys(before.domains ?? {}), ...Object.keys(after.domains ?? {})])].sort(
    compareText,
  );
  for (const key of keys) {
    const left = before.domains?.[key];
    const right = after.domains?.[key];
    const target = typeTarget("domain", key, left?.name ?? right?.name);
    if (left === undefined && right !== undefined) {
      const item = change("domain-added", target, undefined, {
        databaseType: right.databaseType,
        tsType: right.tsType,
        nullable: right.nullable,
      });
      output.push({ change: item, keys: [typeKey("domain", key)] });
      continue;
    }
    if (left !== undefined && right === undefined) {
      const item = change(
        "domain-removed",
        target,
        { databaseType: left.databaseType, tsType: left.tsType, nullable: left.nullable },
        undefined,
      );
      output.push({ change: item, keys: [typeKey("domain", key)] });
      continue;
    }
    if (left === undefined || right === undefined) continue;
    for (const [kind, property] of [
      ["domain-database-type", "databaseType"],
      ["domain-typescript-type", "tsType"],
      ["domain-nullability", "nullable"],
    ] as const) {
      if (left[property] === right[property]) continue;
      const item = change(kind, target, { [property]: left[property] }, { [property]: right[property] });
      output.push({ change: item, keys: [typeKey("domain", key)] });
    }
  }
  return output;
}

function functionEvidence(value: NonNullable<SchemaSnapshot["functions"]>[string]): CompatibilityEvidence {
  return {
    arguments: value.argumentTypes,
    databaseReturnType: value.databaseReturnType ?? null,
    returnType: value.returnType,
    nullable: value.nullable,
    setReturning: value.setReturning ?? false,
    volatility: value.volatility ?? null,
  };
}

function functionChanges(before: SchemaSnapshot, after: SchemaSnapshot): InternalChange[] {
  const output: InternalChange[] = [];
  const keys = [...new Set([...Object.keys(before.functions ?? {}), ...Object.keys(after.functions ?? {})])].sort(
    compareText,
  );
  for (const key of keys) {
    const left = before.functions?.[key];
    const right = after.functions?.[key];
    const value = left ?? right;
    if (value === undefined) continue;
    const target = functionTarget(key, value);
    const impactKeys = [functionKey(key), functionNameKey(value.schema, value.name)];
    if (left === undefined && right !== undefined) {
      output.push({ change: change("function-added", target, undefined, functionEvidence(right)), keys: impactKeys });
      continue;
    }
    if (left !== undefined && right === undefined) {
      output.push({ change: change("function-removed", target, functionEvidence(left), undefined), keys: impactKeys });
      continue;
    }
    if (left === undefined || right === undefined) continue;
    for (const [kind, property, evidenceName] of [
      ["function-return-type", "databaseReturnType", "databaseReturnType"],
      ["function-return-type", "returnType", "returnType"],
      ["function-nullability", "nullable", "nullable"],
      ["function-set-returning", "setReturning", "setReturning"],
      ["function-volatility", "volatility", "volatility"],
    ] as const) {
      const leftValue = left[property] ?? (property === "setReturning" ? false : null);
      const rightValue = right[property] ?? (property === "setReturning" ? false : null);
      if (leftValue === rightValue) continue;
      const item = change(kind, target, { [evidenceName]: leftValue }, { [evidenceName]: rightValue });
      output.push({ change: item, keys: impactKeys });
    }
  }
  return output;
}

function legacySchemaChanges(before: SchemaSnapshot, after: SchemaSnapshot): InternalChange[] {
  const output: InternalChange[] = [
    ...enumChanges(before, after),
    ...domainChanges(before, after),
    ...functionChanges(before, after),
  ];
  const tableKeys = [...new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])].sort(compareText);
  for (const tableKey of tableKeys) {
    const leftTable = before.tables[tableKey];
    const rightTable = after.tables[tableKey];
    const table = leftTable ?? rightTable;
    if (table === undefined) continue;
    if (leftTable === undefined && rightTable !== undefined) {
      output.push({
        change: change("relation-added", relationTarget(tableKey, rightTable), undefined, {}),
        keys: [relationKey(tableKey)],
      });
      continue;
    }
    if (leftTable !== undefined && rightTable === undefined) {
      output.push({
        change: change("relation-removed", relationTarget(tableKey, leftTable), {}, undefined),
        keys: [relationKey(tableKey)],
      });
      continue;
    }
    if (leftTable === undefined || rightTable === undefined) continue;
    const columnNames = [...new Set([...Object.keys(leftTable.columns), ...Object.keys(rightTable.columns)])].sort(
      compareText,
    );
    for (const name of columnNames) {
      const left = leftTable.columns[name];
      const right = rightTable.columns[name];
      const target = columnTarget(tableKey, table, name);
      if (left === undefined && right !== undefined) {
        output.push({
          change: change("column-added", target, undefined, {
            databaseType: right.databaseType,
            tsType: right.tsType,
            nullable: right.nullable,
            ...defaultEvidence(right.defaultExpression),
          }),
          keys: [columnKey(tableKey, name)],
          relationWriteKey: relationWriteKey(tableKey),
          addedMandatoryColumn: !right.nullable && right.defaultExpression === undefined,
        });
        continue;
      }
      if (left !== undefined && right === undefined) {
        output.push({
          change: change(
            "column-removed",
            target,
            {
              databaseType: left.databaseType,
              tsType: left.tsType,
              nullable: left.nullable,
              ...defaultEvidence(left.defaultExpression),
            },
            undefined,
          ),
          keys: [columnKey(tableKey, name)],
          relationWriteKey: relationWriteKey(tableKey),
          removedMandatoryColumn: !left.nullable && left.defaultExpression === undefined,
        });
        continue;
      }
      if (left === undefined || right === undefined) continue;
      for (const [kind, property] of [
        ["column-database-type", "databaseType"],
        ["column-typescript-type", "tsType"],
        ["column-nullability", "nullable"],
      ] as const) {
        if (left[property] === right[property]) continue;
        output.push({
          change: change(kind, target, { [property]: left[property] }, { [property]: right[property] }),
          keys: [columnKey(tableKey, name)],
          relationWriteKey: relationWriteKey(tableKey),
        });
      }
      if ((left.array ?? false) !== (right.array ?? false)) {
        output.push({
          change: change("column-array", target, { array: left.array ?? false }, { array: right.array ?? false }),
          keys: [columnKey(tableKey, name)],
        });
      }
      if (left.defaultExpression !== right.defaultExpression) {
        output.push({
          change: change(
            "column-default",
            target,
            defaultEvidence(left.defaultExpression),
            defaultEvidence(right.defaultExpression),
          ),
          keys: [columnKey(tableKey, name)],
          relationWriteKey: relationWriteKey(tableKey),
        });
      }
    }
  }
  if (before.version !== after.version) {
    output.push({
      change: change(
        "server-version",
        { kind: "schema", key: before.dialect, name: before.dialect },
        { version: before.version ?? null },
        { version: after.version ?? null },
      ),
      keys: ["all-queries"],
    });
  }
  if (before.dialectVersion !== after.dialectVersion) {
    output.push({
      change: change(
        "dialect-version",
        { kind: "schema", key: before.dialect, name: before.dialect },
        { version: before.dialectVersion ?? null },
        { version: after.dialectVersion ?? null },
      ),
      keys: ["all-queries"],
    });
  }
  return output.sort(
    (left, right) =>
      compareText(targetIdentity(left.change.target), targetIdentity(right.change.target)) ||
      compareText(left.change.kind, right.change.kind),
  );
}

function structuralEvidence(family: string, value: unknown): CompatibilityEvidence {
  return { family, fingerprint: `sha256:${sha256(JSON.stringify(canonicalize(value)))}` };
}

function v2Target(
  kind: SchemaCompatibilityTarget["kind"],
  key: string,
  value: { readonly name: string; readonly schema?: string },
  parent?: string,
): SchemaCompatibilityTarget {
  return {
    kind,
    key,
    name: value.name,
    ...(value.schema === undefined ? {} : { schema: value.schema }),
    ...(parent === undefined ? {} : { parent }),
  };
}

function definitionChanges<Value extends { readonly name: string; readonly schema?: string }>(options: {
  readonly before: Readonly<Record<string, Value>>;
  readonly after: Readonly<Record<string, Value>>;
  readonly targetKind: SchemaCompatibilityTarget["kind"];
  readonly family: (value: Value) => string;
  readonly added: SchemaCompatibilityChangeKind;
  readonly removed: SchemaCompatibilityChangeKind;
  readonly definition: SchemaCompatibilityChangeKind;
  readonly keys: (key: string, value: Value) => readonly string[];
  readonly parent?: string;
}): InternalChange[] {
  const output: InternalChange[] = [];
  const keys = [...new Set([...Object.keys(options.before), ...Object.keys(options.after)])].sort(compareText);
  for (const key of keys) {
    const left = options.before[key];
    const right = options.after[key];
    const value = left ?? right;
    if (value === undefined) continue;
    const target = v2Target(options.targetKind, key, value, options.parent);
    const impactKeys = options.keys(key, value);
    if (left === undefined && right !== undefined) {
      output.push({
        change: change(options.added, target, undefined, structuralEvidence(options.family(right), right)),
        keys: impactKeys,
      });
    } else if (left !== undefined && right === undefined) {
      output.push({
        change: change(options.removed, target, structuralEvidence(options.family(left), left), undefined),
        keys: impactKeys,
      });
    } else if (
      left !== undefined &&
      right !== undefined &&
      JSON.stringify(canonicalize(left)) !== JSON.stringify(canonicalize(right))
    ) {
      output.push({
        change: change(
          options.definition,
          target,
          structuralEvidence(options.family(left), left),
          structuralEvidence(options.family(right), right),
        ),
        keys: impactKeys,
      });
    }
  }
  return output;
}

function relationMemberChanges(tableKey: string, before: RelationSnapshot, after: RelationSnapshot): InternalChange[] {
  const output: InternalChange[] = [];
  const columnNames = [...new Set([...Object.keys(before.columns), ...Object.keys(after.columns)])].sort(compareText);
  for (const name of columnNames) {
    const left = before.columns[name];
    const right = after.columns[name];
    const value = left ?? right;
    if (value === undefined) continue;
    const target = v2Target("column", `${tableKey}.${name}`, value, tableKey);
    if (left === undefined && right !== undefined) {
      output.push({
        change: change("column-added", target, undefined, structuralEvidence("column", right)),
        keys: [columnKey(tableKey, name)],
        relationWriteKey: relationWriteKey(tableKey),
        addedMandatoryColumn:
          right.insertable === true &&
          right.nullable === false &&
          right.default === "none" &&
          right.generated === "none" &&
          right.identity === "none",
      });
    } else if (left !== undefined && right === undefined) {
      output.push({
        change: change("column-removed", target, structuralEvidence("column", left), undefined),
        keys: [columnKey(tableKey, name)],
        relationWriteKey: relationWriteKey(tableKey),
        removedMandatoryColumn:
          left.insertable === true &&
          left.nullable === false &&
          left.default === "none" &&
          left.generated === "none" &&
          left.identity === "none",
      });
    } else if (
      left !== undefined &&
      right !== undefined &&
      JSON.stringify(canonicalize(left)) !== JSON.stringify(canonicalize(right))
    ) {
      output.push({
        change: change(
          "column-structure",
          target,
          structuralEvidence("column", left),
          structuralEvidence("column", right),
        ),
        keys: [columnKey(tableKey, name)],
        relationWriteKey: relationWriteKey(tableKey),
      });
    }
  }
  for (const [targetKind, family, leftValues, rightValues, added, removed, definition] of [
    [
      "constraint",
      "constraint",
      before.constraints,
      after.constraints,
      "constraint-added",
      "constraint-removed",
      "constraint-definition",
    ],
    ["index", "index", before.indexes, after.indexes, "index-added", "index-removed", "index-definition"],
  ] as const) {
    const left = Object.fromEntries(
      leftValues.map((value) => [value.identity, { ...value, name: value.name ?? value.identity }]),
    );
    const right = Object.fromEntries(
      rightValues.map((value) => [value.identity, { ...value, name: value.name ?? value.identity }]),
    );
    output.push(
      ...definitionChanges({
        before: left,
        after: right,
        targetKind,
        family: () => family,
        added,
        removed,
        definition,
        keys: () => [relationKey(tableKey)],
        parent: tableKey,
      }),
    );
  }
  return output;
}

function v2SchemaChanges(
  before: Extract<SchemaSnapshot, { readonly formatVersion: 2 }>,
  after: Extract<SchemaSnapshot, { readonly formatVersion: 2 }>,
): InternalChange[] {
  const output: InternalChange[] = [];
  output.push(
    ...definitionChanges({
      before: before.namespaces,
      after: after.namespaces,
      targetKind: "namespace",
      family: (value) => value.kind,
      added: "namespace-added",
      removed: "namespace-removed",
      definition: "namespace-definition",
      keys: () => ["all-queries"],
    }),
  );
  const relationKeys = [...new Set([...Object.keys(before.relations), ...Object.keys(after.relations)])].sort(
    compareText,
  );
  for (const key of relationKeys) {
    const left = before.relations[key];
    const right = after.relations[key];
    const value = left ?? right;
    if (value === undefined) continue;
    const target = v2Target("relation", key, value);
    if (left === undefined && right !== undefined) {
      output.push({
        change: change("relation-added", target, undefined, structuralEvidence(right.kind, right)),
        keys: [relationKey(key)],
      });
      continue;
    }
    if (left !== undefined && right === undefined) {
      output.push({
        change: change("relation-removed", target, structuralEvidence(left.kind, left), undefined),
        keys: [relationKey(key)],
      });
      continue;
    }
    if (left === undefined || right === undefined) continue;
    const relationDefinition = (relation: RelationSnapshot) => ({
      kind: relation.kind,
      capabilities: relation.capabilities,
      extension: relation.extension,
    });
    if (
      JSON.stringify(canonicalize(relationDefinition(left))) !== JSON.stringify(canonicalize(relationDefinition(right)))
    ) {
      output.push({
        change: change(
          "relation-definition",
          target,
          structuralEvidence(left.kind, relationDefinition(left)),
          structuralEvidence(right.kind, relationDefinition(right)),
        ),
        keys: [relationKey(key)],
      });
    }
    output.push(...relationMemberChanges(key, left, right));
  }
  output.push(
    ...definitionChanges<TypeSnapshot>({
      before: before.types,
      after: after.types,
      targetKind: "type",
      family: (value) => value.kind,
      added: "type-added",
      removed: "type-removed",
      definition: "type-definition",
      keys: (key) => [structuralTypeKey(key)],
    }),
  );
  const flattenRoutines = (values: Readonly<Record<string, readonly RoutineSnapshot[]>>) =>
    Object.fromEntries(
      Object.values(values)
        .flat()
        .map((value) => [value.identity, value]),
    );
  output.push(
    ...definitionChanges<RoutineSnapshot>({
      before: flattenRoutines(before.routines),
      after: flattenRoutines(after.routines),
      targetKind: "routine",
      family: (value) => value.kind,
      added: "routine-added",
      removed: "routine-removed",
      definition: "routine-definition",
      keys: (_key, value) => [routineKey(value.schema, value.name), functionNameKey(value.schema, value.name)],
    }),
  );
  if (JSON.stringify(canonicalize(before.server)) !== JSON.stringify(canonicalize(after.server))) {
    output.push({
      change: change(
        before.server.version === after.server.version ? "server-evidence" : "server-version",
        { kind: "schema", key: before.dialect, name: before.dialect },
        structuralEvidence("server", before.server),
        structuralEvidence("server", after.server),
      ),
      keys: ["all-queries"],
    });
  }
  if (JSON.stringify(canonicalize(before.extension)) !== JSON.stringify(canonicalize(after.extension))) {
    output.push({
      change: change(
        "extension-definition",
        { kind: "extension", key: before.dialect, name: before.dialect },
        structuralEvidence("extension", before.extension ?? null),
        structuralEvidence("extension", after.extension ?? null),
      ),
      keys: ["all-queries"],
    });
  }
  if (before.dialectVersion !== after.dialectVersion) {
    output.push({
      change: change(
        "dialect-version",
        { kind: "schema", key: before.dialect, name: before.dialect },
        { version: before.dialectVersion },
        { version: after.dialectVersion },
      ),
      keys: ["all-queries"],
    });
  }
  return output;
}

function schemaChanges(before: SchemaSnapshot, after: SchemaSnapshot): InternalChange[] {
  const output =
    before.formatVersion === 2 && after.formatVersion === 2
      ? v2SchemaChanges(before, after)
      : legacySchemaChanges(before, after);
  return output.sort(
    (left, right) =>
      compareText(targetIdentity(left.change.target), targetIdentity(right.change.target)) ||
      compareText(left.change.kind, right.change.kind),
  );
}

function matchingTables(snapshot: SchemaSnapshot, name: string, schema?: string) {
  return Object.entries(snapshot.tables).filter(
    ([key, table]) =>
      (key === name || table.name === name || key.endsWith(`.${name}`)) &&
      (schema === undefined || table.schema === schema),
  );
}

function matchingColumns(
  tables: readonly [string, SchemaSnapshot["tables"][string]][],
  name: string,
): readonly [string, string][] {
  return tables.flatMap(([tableKey, table]) =>
    Object.entries(table.columns)
      .filter(([columnKey, column]) => columnKey === name || column.name === name)
      .map(([columnKey]) => [tableKey, columnKey] as const),
  );
}

function matchingTypes(values: Readonly<Record<string, unknown>>, name: string, schema?: string): readonly string[] {
  const matches = Object.keys(values).filter((key) => key === name || key.endsWith(`.${name}`));
  if (schema === undefined) return matches;
  const qualified = matches.filter((key) => key === `${schema}.${name}`);
  return qualified.length === 0 ? matches.filter((key) => !key.includes(".")) : qualified;
}

function matchingStructuralTypes(snapshot: SchemaSnapshot, name: string, schema?: string): readonly string[] {
  if (snapshot.formatVersion !== 2) return [];
  return Object.entries(snapshot.types)
    .filter(
      ([key, value]) =>
        (key === name || key.endsWith(`.${name}`) || value.name === name) &&
        (schema === undefined || value.schema === schema),
    )
    .map(([key]) => key);
}

function addReference(
  map: Map<string, CompatibilityQueryReference[]>,
  key: string,
  reference: CompatibilityQueryReference,
): void {
  map.set(key, [...(map.get(key) ?? []), reference]);
}

function reference(
  entryId: string,
  variant: QueryManifestVariant,
  source: QueryManifestLocation,
  dependency?: QueryDependency,
): CompatibilityQueryReference {
  return {
    queryId: entryId,
    variantFingerprint: variant.fingerprint,
    source,
    ...(dependency === undefined ? {} : { dependencyRange: dependency.range }),
  };
}

function manifestReferences(manifest: QueryManifest, snapshot: SchemaSnapshot): ManifestReferences {
  const byKey = new Map<string, CompatibilityQueryReference[]>();
  const unknown: CompatibilityQueryReference[] = [];
  for (const entry of manifest.queries) {
    if (entry.status === "unresolved") {
      unknown.push({ queryId: entry.id, variantFingerprint: entry.id, source: entry.source });
      continue;
    }
    for (const variant of entry.variants) {
      if (
        variant.semantics.operation.value === "unknown" ||
        variant.semantics.cardinality.maximum === "unknown" ||
        variant.semantics.volatility.value === "unknown" ||
        variant.semantics.locking.value === "unknown" ||
        variant.semantics.connectionAffinity.value === "unknown"
      ) {
        unknown.push(reference(entry.id, variant, entry.source));
      }
      const relationMatches = new Map<QueryDependency, readonly [string, SchemaSnapshot["tables"][string]][]>();
      for (const dependency of variant.semantics.dependencies.filter((item) => item.kind === "relation")) {
        const matches = matchingTables(snapshot, dependency.name, dependency.schema);
        relationMatches.set(dependency, matches);
        const item = reference(entry.id, variant, entry.source, dependency);
        if (matches.length === 1) {
          addReference(byKey, relationKey(matches[0]![0]), item);
          if (dependency.access === "write") addReference(byKey, relationWriteKey(matches[0]![0]), item);
        } else unknown.push(item);
      }
      for (const dependency of variant.semantics.dependencies.filter((item) => item.kind !== "relation")) {
        const item = reference(entry.id, variant, entry.source, dependency);
        if (dependency.kind === "column") {
          let matches = dependency.parent === undefined ? [] : matchingTables(snapshot, dependency.parent);
          if (matches.length === 0) {
            matches = [...new Map([...relationMatches.values()].flat().map((value) => [value[0], value])).values()];
          }
          const columns = matchingColumns(matches, dependency.name);
          if (columns.length === 1) {
            addReference(byKey, columnKey(columns[0]![0], columns[0]![1]), item);
          } else unknown.push(item);
        } else if (dependency.kind === "function") {
          if (snapshot.formatVersion === 2) {
            const matches = Object.values(snapshot.routines)
              .flat()
              .filter(
                (routine) =>
                  routine.name === dependency.name &&
                  (dependency.schema === undefined || routine.schema === dependency.schema),
              );
            if (matches.length > 0) {
              addReference(byKey, routineKey(dependency.schema ?? matches[0]?.schema, dependency.name), item);
              addReference(byKey, functionNameKey(dependency.schema ?? matches[0]?.schema, dependency.name), item);
            } else if (dependency.certainty === "resolved") unknown.push(item);
            continue;
          }
          const matches = Object.entries(snapshot.functions ?? {}).filter(
            ([, fn]) =>
              fn.name === dependency.name && (dependency.schema === undefined || fn.schema === dependency.schema),
          );
          if (matches.length === 1) addReference(byKey, functionKey(matches[0]![0]), item);
          if (matches.length > 0)
            addReference(byKey, functionNameKey(dependency.schema ?? matches[0]?.[1].schema, dependency.name), item);
          else if (dependency.certainty === "resolved") unknown.push(item);
        } else if (dependency.kind === "type") {
          const structural = matchingStructuralTypes(snapshot, dependency.name, dependency.schema);
          if (structural.length === 1) {
            addReference(byKey, structuralTypeKey(structural[0]!), item);
            continue;
          }
          if (structural.length > 1) {
            unknown.push(item);
            continue;
          }
          const enums = matchingTypes(snapshot.enums ?? {}, dependency.name, dependency.schema);
          const domains = matchingTypes(snapshot.domains ?? {}, dependency.name, dependency.schema);
          if (enums.length + domains.length === 1) {
            if (enums.length === 1) addReference(byKey, typeKey("enum", enums[0]!), item);
            else addReference(byKey, typeKey("domain", domains[0]!), item);
          } else if (enums.length + domains.length > 1 || dependency.certainty === "resolved") unknown.push(item);
        } else if (dependency.kind === "unknown" || dependency.kind === "sequence") unknown.push(item);
      }
      addReference(byKey, "all-queries", reference(entry.id, variant, entry.source));
    }
  }
  return { byKey, unknown: uniqueReferences(unknown) };
}

function uniqueReferences(values: readonly CompatibilityQueryReference[]): readonly CompatibilityQueryReference[] {
  const unique = new Map<string, CompatibilityQueryReference>();
  for (const value of values) {
    const key = `${value.queryId}\0${value.variantFingerprint}\0${value.dependencyRange?.start ?? -1}`;
    unique.set(key, value);
  }
  return [...unique.values()].sort(
    (left, right) =>
      compareText(left.source.file, right.source.file) ||
      left.source.range.start - right.source.range.start ||
      compareText(left.variantFingerprint, right.variantFingerprint) ||
      (left.dependencyRange?.start ?? -1) - (right.dependencyRange?.start ?? -1),
  );
}

function affected(
  change: InternalChange,
  references: ManifestReferences,
  direction: DeploymentDirection,
): readonly CompatibilityQueryReference[] {
  const values = change.keys.flatMap((key) => references.byKey.get(key) ?? []);
  if (
    change.relationWriteKey !== undefined &&
    ((change.addedMandatoryColumn === true && direction === "before-app-after-database") ||
      (change.removedMandatoryColumn === true && direction === "after-app-before-database") ||
      change.change.kind === "column-default" ||
      change.change.kind === "column-nullability")
  ) {
    values.push(...(references.byKey.get(change.relationWriteKey) ?? []));
  }
  return uniqueReferences(values);
}

function risk(
  item: InternalChange,
  direction: DeploymentDirection,
  queries: readonly CompatibilityQueryReference[],
): Pick<SchemaCompatibilityAssessment, "classification" | "severity" | "reason"> {
  const kind = item.change.kind;
  if (queries.length === 0)
    return {
      classification: "compatible",
      severity: "info",
      reason: "No compiled query in this application version depends on the changed contract.",
    };
  if (
    kind === "server-version" ||
    kind === "server-evidence" ||
    kind === "dialect-version" ||
    kind === "extension-definition"
  )
    return {
      classification: "unknown",
      severity: "warning",
      reason: "Database-version compatibility requires live verification in a representative environment.",
    };
  if (kind.startsWith("index-") || kind.startsWith("namespace-")) {
    return {
      classification: "compatible",
      severity: "info",
      reason: "This metadata does not change the compiled query type or runtime relation contract.",
    };
  }
  if (kind.startsWith("constraint-")) {
    return {
      classification: "deployment-order-sensitive",
      severity: "warning",
      reason: "Constraint evidence can change cardinality, conflict-target, or write validation during deployment.",
    };
  }
  if (kind === "column-typescript-type" || kind === "domain-typescript-type" || kind === "query-contract") {
    return {
      classification: "source-breaking",
      severity: "error",
      reason: "The inferred TypeScript query contract changes.",
    };
  }
  if (kind === "function-volatility" || kind === "column-default") {
    return {
      classification: "deployment-order-sensitive",
      severity: "warning",
      reason: "The query can depend on changed execution or default-value semantics during a rolling deployment.",
    };
  }
  if (kind.endsWith("-added")) {
    if (direction === "after-app-before-database")
      return {
        classification: "runtime-breaking",
        severity: "error",
        reason: "The newer application references a contract that the older database does not provide.",
      };
    if (kind === "function-added" || kind === "routine-added" || item.addedMandatoryColumn === true)
      return {
        classification: "deployment-order-sensitive",
        severity: "error",
        reason: "The added contract can change overload resolution or make existing writes incomplete.",
      };
    return {
      classification: "compatible",
      severity: "info",
      reason: "The older application does not require the additive contract.",
    };
  }
  if (kind.endsWith("-removed")) {
    if (direction === "before-app-after-database")
      return {
        classification: "runtime-breaking",
        severity: "error",
        reason: "The older application references a contract removed from the newer database.",
      };
    if (kind === "function-removed" || kind === "routine-removed")
      return {
        classification: "deployment-order-sensitive",
        severity: "warning",
        reason:
          "An overload present only on the older database can change function resolution for the newer application.",
      };
    if (item.removedMandatoryColumn === true)
      return {
        classification: "deployment-order-sensitive",
        severity: "error",
        reason: "The newer application can omit a value still required by the older database.",
      };
    return {
      classification: "compatible",
      severity: "info",
      reason: "The newer application does not require the removed contract.",
    };
  }
  return {
    classification: "runtime-breaking",
    severity: "error",
    reason: "The database contract used by the query changes incompatibly across deployment versions.",
  };
}

function manifestHash(manifest: QueryManifest): string {
  return `sha256:${sha256(serializeQueryManifest(manifest))}`;
}

function validateInputs(options: AnalyzeSchemaCompatibilityOptions): void {
  parseQueryManifest(options.beforeManifest);
  parseQueryManifest(options.afterManifest);
  const dialect = options.before.dialect;
  if (
    options.after.dialect !== dialect ||
    options.beforeManifest.dialect.id !== dialect ||
    options.afterManifest.dialect.id !== dialect
  ) {
    throw new TypeError("Compatibility snapshots and manifests must use the same dialect");
  }
  const beforeHash = calculateSchemaHash(options.before);
  const afterHash = calculateSchemaHash(options.after);
  if (options.beforeManifest.schemaHash !== beforeHash)
    throw new TypeError("Before manifest is stale for the before snapshot");
  if (options.afterManifest.schemaHash !== afterHash)
    throw new TypeError("After manifest is stale for the after snapshot");
}

function queryContractChanges(before: QueryManifest, after: QueryManifest): InternalChange[] {
  const output: InternalChange[] = [];
  const afterEntries = new Map(
    after.queries
      .filter((entry) => entry.status === "resolved")
      .map((entry) => [`${entry.source.file}\0${entry.source.range.start}\0${entry.fingerprint}`, entry] as const),
  );
  for (const entry of before.queries) {
    if (entry.status !== "resolved") continue;
    const other = afterEntries.get(`${entry.source.file}\0${entry.source.range.start}\0${entry.fingerprint}`);
    if (other === undefined) continue;
    const otherVariants = new Map(other.variants.map((variant) => [variant.fingerprint, variant]));
    for (const variant of entry.variants) {
      const afterVariant = otherVariants.get(variant.fingerprint);
      if (
        afterVariant === undefined ||
        (variant.rowType === afterVariant.rowType && variant.parameterType === afterVariant.parameterType)
      )
        continue;
      const target: SchemaCompatibilityTarget = { kind: "query", key: entry.id, name: entry.id };
      const item = change(
        "query-contract",
        target,
        { rowType: variant.rowType, parameterType: variant.parameterType },
        { rowType: afterVariant.rowType, parameterType: afterVariant.parameterType },
      );
      output.push({
        change: item,
        keys: [`query:${item.id}`],
        queryReferences: {
          "before-app-after-database": reference(entry.id, variant, entry.source),
          "after-app-before-database": reference(other.id, afterVariant, other.source),
        },
      });
    }
  }
  return output;
}

export function analyzeSchemaCompatibility(options: AnalyzeSchemaCompatibilityOptions): SchemaCompatibilityReport {
  const normalize = (snapshot: CoreSchemaSnapshot): SchemaSnapshot =>
    snapshot.formatVersion === 2
      ? parseSchemaSnapshot(JSON.parse(serializeSchemaSnapshot(snapshot as SchemaSnapshot)) as unknown)
      : parseSchemaSnapshot(snapshot);
  const before = normalize(options.before);
  const after = normalize(options.after);
  validateInputs(options);
  const beforeReferences = manifestReferences(options.beforeManifest, before);
  const afterReferences = manifestReferences(options.afterManifest, after);
  const changes = [
    ...schemaChanges(before, after),
    ...queryContractChanges(options.beforeManifest, options.afterManifest),
  ].sort(
    (left, right) =>
      compareText(targetIdentity(left.change.target), targetIdentity(right.change.target)) ||
      compareText(left.change.kind, right.change.kind),
  );
  const assessments: SchemaCompatibilityAssessment[] = [];
  for (const item of changes) {
    for (const direction of ["before-app-after-database", "after-app-before-database"] as const) {
      const references = direction === "before-app-after-database" ? beforeReferences : afterReferences;
      const explicit = item.queryReferences?.[direction];
      const queries = explicit === undefined ? affected(item, references, direction) : [explicit];
      assessments.push({ direction, changeId: item.change.id, ...risk(item, direction, queries), queries });
    }
  }
  for (const [direction, references] of [
    ["before-app-after-database", beforeReferences],
    ["after-app-before-database", afterReferences],
  ] as const) {
    for (const query of references.unknown) {
      assessments.push({
        direction,
        classification: "unknown",
        severity: "warning",
        reason: "The manifest contains an unresolved query or dependency, so compatibility cannot be proven.",
        queries: [query],
      });
    }
  }
  assessments.sort(
    (left, right) =>
      compareText(left.direction, right.direction) ||
      compareText(left.changeId ?? "", right.changeId ?? "") ||
      compareText(left.queries[0]?.source.file ?? "", right.queries[0]?.source.file ?? "") ||
      (left.queries[0]?.source.range.start ?? -1) - (right.queries[0]?.source.range.start ?? -1),
  );
  const report: SchemaCompatibilityReport = {
    formatVersion: SCHEMA_COMPATIBILITY_FORMAT_VERSION,
    analyzerVersion: SCHEMA_COMPATIBILITY_ANALYZER_VERSION,
    dialect: before.dialect,
    before: {
      schemaHash: options.beforeManifest.schemaHash,
      manifestHash: manifestHash(options.beforeManifest),
      schemaFormat: before.formatVersion,
      ...(before.version === undefined ? {} : { version: before.version }),
    },
    after: {
      schemaHash: options.afterManifest.schemaHash,
      manifestHash: manifestHash(options.afterManifest),
      schemaFormat: after.formatVersion,
      ...(after.version === undefined ? {} : { version: after.version }),
    },
    changes: changes.map((item) => item.change),
    assessments,
    summary: {
      info: assessments.filter((item) => item.severity === "info").length,
      warning: assessments.filter((item) => item.severity === "warning").length,
      error: assessments.filter((item) => item.severity === "error").length,
    },
  };
  return report;
}

export function serializeSchemaCompatibilityReport(report: SchemaCompatibilityReport): string {
  return `${JSON.stringify(canonicalize(report), null, 2)}\n`;
}

export function parseSchemaCompatibilityReport(value: unknown): SchemaCompatibilityReport {
  if (!record(value)) throw new TypeError("Compatibility report must be an object");
  const report = value;
  if (report.formatVersion !== SCHEMA_COMPATIBILITY_FORMAT_VERSION)
    throw new TypeError(`Unsupported compatibility report format ${String(report.formatVersion)}`);
  if (report.analyzerVersion !== SCHEMA_COMPATIBILITY_ANALYZER_VERSION)
    throw new TypeError(`Unsupported compatibility analyzer ${String(report.analyzerVersion)}`);
  assertNonEmptyString(report.dialect, "Compatibility report dialect");
  for (const [name, artifact] of [
    ["before", report.before],
    ["after", report.after],
  ] as const) {
    if (!record(artifact)) throw new TypeError(`Compatibility report ${name} artifact is invalid`);
    assertDigest(artifact.schemaHash, `Compatibility report ${name}.schemaHash`);
    assertHash(artifact.manifestHash, `Compatibility report ${name}.manifestHash`);
    if (artifact.schemaFormat !== undefined && artifact.schemaFormat !== 1 && artifact.schemaFormat !== 2) {
      throw new TypeError(`Compatibility report ${name}.schemaFormat must be 1 or 2`);
    }
    assertOptionalString(artifact.version, `Compatibility report ${name}.version`);
  }
  if (!Array.isArray(report.changes)) throw new TypeError("Compatibility report changes must be an array");
  const changeIds = new Set<string>();
  for (const [index, item] of report.changes.entries()) {
    const description = `Compatibility report change ${index}`;
    if (!record(item) || !changeKinds.has(item.kind as SchemaCompatibilityChangeKind) || !record(item.target)) {
      throw new TypeError(`${description} is invalid`);
    }
    const target = item.target;
    if (!targetKinds.has(target.kind as SchemaCompatibilityTarget["kind"])) {
      throw new TypeError(`${description}.target.kind is invalid`);
    }
    assertNonEmptyString(target.key, `${description}.target.key`);
    assertNonEmptyString(target.name, `${description}.target.name`);
    assertOptionalString(target.schema, `${description}.target.schema`);
    assertOptionalString(target.parent, `${description}.target.parent`);
    if (item.before !== undefined) assertEvidence(item.before, `${description}.before`);
    if (item.after !== undefined) assertEvidence(item.after, `${description}.after`);
    assertHash(item.id, `${description}.id`);
    const expected = change(
      item.kind as SchemaCompatibilityChangeKind,
      target as unknown as SchemaCompatibilityTarget,
      item.before as CompatibilityEvidence | undefined,
      item.after as CompatibilityEvidence | undefined,
    ).id;
    if (item.id !== expected) throw new TypeError(`${description}.id does not match its canonical evidence`);
    if (changeIds.has(item.id)) throw new TypeError(`${description}.id is duplicated`);
    changeIds.add(item.id);
  }
  if (!Array.isArray(report.assessments)) throw new TypeError("Compatibility report assessments must be an array");
  const counted: Record<CompatibilitySeverity, number> = { info: 0, warning: 0, error: 0 };
  for (const [index, item] of report.assessments.entries()) {
    const description = `Compatibility report assessment ${index}`;
    if (
      !record(item) ||
      !directions.has(item.direction as DeploymentDirection) ||
      !classifications.has(item.classification as CompatibilityClassification) ||
      !severities.has(item.severity as CompatibilitySeverity) ||
      !Array.isArray(item.queries)
    ) {
      throw new TypeError(`${description} is invalid`);
    }
    assertNonEmptyString(item.reason, `${description}.reason`);
    if (item.changeId !== undefined) {
      assertHash(item.changeId, `${description}.changeId`);
      if (!changeIds.has(item.changeId))
        throw new TypeError(`${description}.changeId does not identify a report change`);
    }
    for (const [queryIndex, query] of item.queries.entries()) {
      assertQueryReference(query, `${description}.queries[${queryIndex}]`);
    }
    counted[item.severity as CompatibilitySeverity] += 1;
  }
  if (!record(report.summary)) throw new TypeError("Compatibility report summary is invalid");
  for (const severity of ["info", "warning", "error"] as const) {
    if (!Number.isSafeInteger(report.summary[severity]) || report.summary[severity] !== counted[severity])
      throw new TypeError("Compatibility report summary is invalid");
  }
  return value as unknown as SchemaCompatibilityReport;
}
