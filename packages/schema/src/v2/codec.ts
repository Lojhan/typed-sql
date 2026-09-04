import { parseDialectServerEvidence } from "@typed-sql/core";
import type {
  CheckConstraintSnapshot,
  CollectionTypeSnapshot,
  ColumnSnapshot,
  ColumnSnapshotV2,
  CompositeTypeFieldSnapshot,
  ConstraintSnapshot,
  DialectExtensionSnapshot,
  DialectExtensionValue,
  DomainSnapshot,
  ExclusionConstraintElementSnapshot,
  FunctionSnapshot,
  GeneratedSchemaMetadata,
  IndexColumnSnapshot,
  IndexSnapshot,
  NamespaceSnapshot,
  RelationSnapshot,
  RoutineArgumentSnapshot,
  RoutineResultSnapshot,
  RoutineSnapshot,
  SchemaSnapshotV2,
  SchemaSnapshotV2Envelope,
  TableSnapshot,
  TypeSnapshot,
} from "../model.js";
import { compareSchemaKeys } from "../ordering.js";
import { SCHEMA_FORMAT_VERSION } from "./model.js";

type RecordValue = Readonly<Record<string, unknown>>;

const secretKeyPattern =
  /(?:authorization|connection|string|credential|databaseurl|dsn|error|password|path|permission|sample|secret|statistic|token|url|user)/iu;
const sensitiveValuePattern = /(?:[a-z][a-z0-9+.-]*:\/\/|(?:password|secret|token)\s*[=:]|(?:^|[\\/])Users[\\/])/iu;
const fingerprintPattern = /^sha256:[a-f\d]{64}$/u;

function record(value: unknown, path: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${path} must be an object`);
  return value as RecordValue;
}

function allowed(value: RecordValue, keys: readonly string[], path: string): void {
  const unknown = Object.keys(value)
    .filter((key) => !keys.includes(key))
    .sort();
  if (unknown.length > 0) throw new TypeError(`${path} contains unknown properties: ${unknown.join(", ")}`);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${path} must be a non-empty string`);
  if (value.length > 2_000 || [...value].some((item) => item.charCodeAt(0) < 32 || item.charCodeAt(0) === 127)) {
    throw new TypeError(`${path} is not safe artifact text`);
  }
  if (sensitiveValuePattern.test(value)) throw new TypeError(`${path} appears to contain secret material`);
  return value;
}

function optionalText(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : text(value, path);
}

function parseMetadata(value: unknown, path: string): GeneratedSchemaMetadata | undefined {
  if (value === undefined) return undefined;
  const source = record(value, path);
  allowed(source, ["generatorVersion", "schemaHash", "typePolicyHash", "schemaFormat"], path);
  const schemaFormat = source.schemaFormat;
  if (schemaFormat !== undefined && schemaFormat !== 1 && schemaFormat !== 2) {
    throw new TypeError(`${path}.schemaFormat must be 1 or 2`);
  }
  return {
    generatorVersion: text(source.generatorVersion, `${path}.generatorVersion`),
    schemaHash: text(source.schemaHash, `${path}.schemaHash`),
    typePolicyHash: text(source.typePolicyHash, `${path}.typePolicyHash`),
    ...(schemaFormat === undefined ? {} : { schemaFormat }),
  };
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`);
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${path} must be a non-negative integer`);
  return value as number;
}

function oneOf<Value extends string>(value: unknown, values: readonly Value[], path: string): Value {
  if (typeof value !== "string" || !values.includes(value as Value)) {
    throw new TypeError(`${path} must be one of: ${values.join(", ")}`);
  }
  return value as Value;
}

function booleanOrUnknown(value: unknown, path: string): boolean | "unknown" {
  if (value === "unknown" || typeof value === "boolean") return value;
  throw new TypeError(`${path} must be a boolean or unknown`);
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value.map((item, index) => text(item, `${path}[${index}]`));
}

function fingerprint(value: unknown, path: string): string {
  if (typeof value !== "string" || !fingerprintPattern.test(value)) {
    throw new TypeError(`${path} must be a sha256 fingerprint`);
  }
  return value;
}

function extensionValue(value: unknown, path: string, key?: string): DialectExtensionValue {
  if (key !== undefined && secretKeyPattern.test(key.replaceAll(/[^A-Za-z]/gu, ""))) {
    throw new TypeError(`${path} is not allowed in schema extension evidence`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be finite`);
    return value;
  }
  if (typeof value === "string") return value.length === 0 ? value : text(value, path);
  if (Array.isArray(value)) return value.map((item, index) => extensionValue(item, `${path}[${index}]`));
  const source = record(value, path);
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((item) => [item, extensionValue(source[item], `${path}.${item}`, item)]),
  );
}

function parseExtension(value: unknown, path: string): DialectExtensionSnapshot | undefined {
  if (value === undefined) return undefined;
  const source = record(value, path);
  allowed(source, ["version", "attributes"], path);
  const attributes = extensionValue(source.attributes, `${path}.attributes`);
  if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes)) {
    throw new TypeError(`${path}.attributes must be an object`);
  }
  return {
    version: text(source.version, `${path}.version`),
    attributes: attributes as Readonly<Record<string, DialectExtensionValue>>,
  };
}

function objectMap<Value>(
  value: unknown,
  path: string,
  parser: (item: unknown, itemPath: string) => Value,
): Readonly<Record<string, Value>> {
  const source = record(value, path);
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, parser(source[key], `${path}.${key}`)]),
  );
}

function parseColumn(value: unknown, path: string): ColumnSnapshotV2 {
  const source = record(value, path);
  allowed(
    source,
    [
      "name",
      "position",
      "databaseType",
      "typeIdentity",
      "tsType",
      "nullable",
      "nullabilitySource",
      "default",
      "defaultExpressionHash",
      "generated",
      "generatedExpressionHash",
      "identity",
      "collation",
      "characterSet",
      "dimensions",
      "classification",
      "insertable",
      "updatable",
      "extension",
    ],
    path,
  );
  const defaultExpressionHash =
    source.defaultExpressionHash === undefined
      ? undefined
      : fingerprint(source.defaultExpressionHash, `${path}.defaultExpressionHash`);
  const dimensions =
    source.dimensions === undefined
      ? undefined
      : Array.isArray(source.dimensions)
        ? source.dimensions.map((item, index) => integer(item, `${path}.dimensions[${index}]`))
        : (() => {
            throw new TypeError(`${path}.dimensions must be an array`);
          })();
  const extension = parseExtension(source.extension, `${path}.extension`);
  return {
    name: text(source.name, `${path}.name`),
    position: integer(source.position, `${path}.position`),
    databaseType: text(source.databaseType, `${path}.databaseType`),
    typeIdentity: text(source.typeIdentity, `${path}.typeIdentity`),
    tsType: text(source.tsType, `${path}.tsType`),
    nullable: bool(source.nullable, `${path}.nullable`),
    nullabilitySource: oneOf(
      source.nullabilitySource,
      ["declared", "domain", "generated", "inferred", "unknown"],
      `${path}.nullabilitySource`,
    ),
    default: oneOf(source.default, ["none", "present", "unknown"], `${path}.default`),
    ...(defaultExpressionHash === undefined ? {} : { defaultExpressionHash }),
    generated: oneOf(source.generated, ["none", "virtual", "stored"], `${path}.generated`),
    ...(source.generatedExpressionHash === undefined
      ? {}
      : { generatedExpressionHash: fingerprint(source.generatedExpressionHash, `${path}.generatedExpressionHash`) }),
    identity: oneOf(source.identity, ["none", "always", "by-default", "unknown"], `${path}.identity`),
    ...(source.collation === undefined ? {} : { collation: text(source.collation, `${path}.collation`) }),
    ...(source.characterSet === undefined ? {} : { characterSet: text(source.characterSet, `${path}.characterSet`) }),
    ...(dimensions === undefined ? {} : { dimensions }),
    classification: oneOf(source.classification, ["normal", "hidden", "system", "rowid"], `${path}.classification`),
    insertable: booleanOrUnknown(source.insertable, `${path}.insertable`),
    updatable: booleanOrUnknown(source.updatable, `${path}.updatable`),
    ...(extension === undefined ? {} : { extension }),
  };
}

function constraintBase(source: RecordValue, path: string) {
  const extension = parseExtension(source.extension, `${path}.extension`);
  return {
    ...(source.name === undefined ? {} : { name: text(source.name, `${path}.name`) }),
    identity: text(source.identity, `${path}.identity`),
    columns: stringArray(source.columns, `${path}.columns`),
    partial: booleanOrUnknown(source.partial, `${path}.partial`),
    expressionBased: booleanOrUnknown(source.expressionBased, `${path}.expressionBased`),
    deferrable: booleanOrUnknown(source.deferrable, `${path}.deferrable`),
    initiallyDeferred: booleanOrUnknown(source.initiallyDeferred, `${path}.initiallyDeferred`),
    ...(extension === undefined ? {} : { extension }),
  };
}

const constraintBaseKeys = [
  "kind",
  "name",
  "identity",
  "columns",
  "partial",
  "expressionBased",
  "deferrable",
  "initiallyDeferred",
  "extension",
] as const;

function parseExclusionElement(value: unknown, path: string): ExclusionConstraintElementSnapshot {
  const source = record(value, path);
  allowed(source, ["column", "expressionHash", "operator", "operatorClass", "collation"], path);
  const column = optionalText(source.column, `${path}.column`);
  const expressionHash =
    source.expressionHash === undefined ? undefined : fingerprint(source.expressionHash, `${path}.expressionHash`);
  if ((column === undefined) === (expressionHash === undefined)) {
    throw new TypeError(`${path} must contain exactly one of column or expressionHash`);
  }
  return {
    ...(column === undefined ? {} : { column }),
    ...(expressionHash === undefined ? {} : { expressionHash }),
    operator: text(source.operator, `${path}.operator`),
    ...(source.operatorClass === undefined
      ? {}
      : { operatorClass: text(source.operatorClass, `${path}.operatorClass`) }),
    ...(source.collation === undefined ? {} : { collation: text(source.collation, `${path}.collation`) }),
  };
}

function parseConstraint(value: unknown, path: string): ConstraintSnapshot {
  const source = record(value, path);
  const kind = oneOf(source.kind, ["primary-key", "unique", "foreign-key", "check", "exclusion"], `${path}.kind`);
  const base = constraintBase(source, path);
  if (kind === "primary-key") {
    allowed(source, [...constraintBaseKeys, "nullsDistinct"], path);
    if (source.nullsDistinct !== false) throw new TypeError(`${path}.nullsDistinct must be false`);
    return { kind, ...base, nullsDistinct: false };
  }
  if (kind === "unique") {
    allowed(source, [...constraintBaseKeys, "nullsDistinct"], path);
    return { kind, ...base, nullsDistinct: booleanOrUnknown(source.nullsDistinct, `${path}.nullsDistinct`) };
  }
  if (kind === "foreign-key") {
    allowed(
      source,
      [...constraintBaseKeys, "referencedRelation", "referencedColumns", "match", "onUpdate", "onDelete"],
      path,
    );
    return {
      kind,
      ...base,
      referencedRelation: text(source.referencedRelation, `${path}.referencedRelation`),
      referencedColumns: stringArray(source.referencedColumns, `${path}.referencedColumns`),
      match: oneOf(source.match, ["simple", "full", "partial", "unknown"], `${path}.match`),
      onUpdate: oneOf(
        source.onUpdate,
        ["no-action", "restrict", "cascade", "set-null", "set-default", "unknown"],
        `${path}.onUpdate`,
      ),
      onDelete: oneOf(
        source.onDelete,
        ["no-action", "restrict", "cascade", "set-null", "set-default", "unknown"],
        `${path}.onDelete`,
      ),
    };
  }
  if (kind === "check") {
    allowed(source, [...constraintBaseKeys, "predicate", "predicateHash"], path);
    const predicateHash =
      source.predicateHash === undefined ? undefined : fingerprint(source.predicateHash, `${path}.predicateHash`);
    const result: CheckConstraintSnapshot = {
      kind,
      ...base,
      predicate: oneOf(source.predicate, ["present", "unknown"], `${path}.predicate`),
      ...(predicateHash === undefined ? {} : { predicateHash }),
    };
    return result;
  }
  allowed(source, [...constraintBaseKeys, "elements", "predicateHash"], path);
  if (!Array.isArray(source.elements)) throw new TypeError(`${path}.elements must be an array`);
  const predicateHash =
    source.predicateHash === undefined ? undefined : fingerprint(source.predicateHash, `${path}.predicateHash`);
  return {
    kind,
    ...base,
    elements: source.elements.map((item, index) => parseExclusionElement(item, `${path}.elements[${index}]`)),
    ...(predicateHash === undefined ? {} : { predicateHash }),
  };
}

function parseIndexColumn(value: unknown, path: string): IndexColumnSnapshot {
  const source = record(value, path);
  allowed(source, ["column", "expressionHash", "descending", "nulls", "operatorClass", "collation"], path);
  const column = optionalText(source.column, `${path}.column`);
  const expressionHash =
    source.expressionHash === undefined ? undefined : fingerprint(source.expressionHash, `${path}.expressionHash`);
  if ((column === undefined) === (expressionHash === undefined)) {
    throw new TypeError(`${path} must contain exactly one of column or expressionHash`);
  }
  return {
    ...(column === undefined ? {} : { column }),
    ...(expressionHash === undefined ? {} : { expressionHash }),
    ...(source.descending === undefined ? {} : { descending: bool(source.descending, `${path}.descending`) }),
    ...(source.nulls === undefined ? {} : { nulls: oneOf(source.nulls, ["first", "last"], `${path}.nulls`) }),
    ...(source.operatorClass === undefined
      ? {}
      : { operatorClass: text(source.operatorClass, `${path}.operatorClass`) }),
    ...(source.collation === undefined ? {} : { collation: text(source.collation, `${path}.collation`) }),
  };
}

function parseIndex(value: unknown, path: string): IndexSnapshot {
  const source = record(value, path);
  allowed(
    source,
    [
      "name",
      "identity",
      "unique",
      "method",
      "columns",
      "includedColumns",
      "predicate",
      "predicateHash",
      "valid",
      "extension",
    ],
    path,
  );
  if (!Array.isArray(source.columns)) throw new TypeError(`${path}.columns must be an array`);
  const extension = parseExtension(source.extension, `${path}.extension`);
  return {
    name: text(source.name, `${path}.name`),
    identity: text(source.identity, `${path}.identity`),
    unique: bool(source.unique, `${path}.unique`),
    ...(source.method === undefined ? {} : { method: text(source.method, `${path}.method`) }),
    columns: source.columns.map((item, index) => parseIndexColumn(item, `${path}.columns[${index}]`)),
    ...(source.includedColumns === undefined
      ? {}
      : { includedColumns: stringArray(source.includedColumns, `${path}.includedColumns`) }),
    predicate: oneOf(source.predicate, ["none", "present", "unknown"], `${path}.predicate`),
    ...(source.predicateHash === undefined
      ? {}
      : { predicateHash: fingerprint(source.predicateHash, `${path}.predicateHash`) }),
    valid: booleanOrUnknown(source.valid, `${path}.valid`),
    ...(extension === undefined ? {} : { extension }),
  };
}

function parseRelation(
  value: unknown,
  path: string,
  compare: (left: string, right: string) => number,
): RelationSnapshot {
  const source = record(value, path);
  allowed(source, ["schema", "name", "kind", "columns", "constraints", "indexes", "capabilities", "extension"], path);
  const columns = objectMap(source.columns, `${path}.columns`, parseColumn);
  const positions = Object.values(columns).map(({ position }) => position);
  if (new Set(positions).size !== positions.length) throw new TypeError(`${path}.columns positions must be unique`);
  if (!Array.isArray(source.constraints)) throw new TypeError(`${path}.constraints must be an array`);
  if (!Array.isArray(source.indexes)) throw new TypeError(`${path}.indexes must be an array`);
  const constraints = source.constraints
    .map((item, index) => parseConstraint(item, `${path}.constraints[${index}]`))
    .sort((left, right) => compare(left.identity, right.identity));
  const indexes = source.indexes
    .map((item, index) => parseIndex(item, `${path}.indexes[${index}]`))
    .sort((left, right) => compare(left.identity, right.identity));
  const capabilities =
    source.capabilities === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(record(source.capabilities, `${path}.capabilities`))
            .sort(([left], [right]) => compare(left, right))
            .map(([key, item]) => {
              if (
                typeof item !== "string" &&
                typeof item !== "boolean" &&
                (typeof item !== "number" || !Number.isFinite(item))
              ) {
                throw new TypeError(`${path}.capabilities.${key} must be a string, boolean, or finite number`);
              }
              return [key, item];
            }),
        );
  const extension = parseExtension(source.extension, `${path}.extension`);
  return {
    ...(source.schema === undefined ? {} : { schema: text(source.schema, `${path}.schema`) }),
    name: text(source.name, `${path}.name`),
    kind: oneOf(source.kind, ["table", "view", "materialized-view", "foreign-table", "virtual-table"], `${path}.kind`),
    columns,
    constraints,
    indexes,
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(extension === undefined ? {} : { extension }),
  };
}

function typeBase(source: RecordValue, path: string) {
  const extension = parseExtension(source.extension, `${path}.extension`);
  return {
    name: text(source.name, `${path}.name`),
    ...(source.schema === undefined ? {} : { schema: text(source.schema, `${path}.schema`) }),
    identity: text(source.identity, `${path}.identity`),
    databaseType: text(source.databaseType, `${path}.databaseType`),
    tsType: text(source.tsType, `${path}.tsType`),
    ...(extension === undefined ? {} : { extension }),
  };
}

const typeBaseKeys = ["kind", "name", "schema", "identity", "databaseType", "tsType", "extension"] as const;

function parseCompositeField(value: unknown, path: string): CompositeTypeFieldSnapshot {
  const source = record(value, path);
  allowed(source, ["name", "typeIdentity", "databaseType", "tsType", "nullable"], path);
  return {
    name: text(source.name, `${path}.name`),
    typeIdentity: text(source.typeIdentity, `${path}.typeIdentity`),
    databaseType: text(source.databaseType, `${path}.databaseType`),
    tsType: text(source.tsType, `${path}.tsType`),
    nullable: bool(source.nullable, `${path}.nullable`),
  };
}

function parseType(value: unknown, path: string): TypeSnapshot {
  const source = record(value, path);
  const kind = oneOf(
    source.kind,
    ["scalar", "enum", "domain", "composite", "range", "multirange", "collection", "opaque"],
    `${path}.kind`,
  );
  const base = typeBase(source, path);
  if (kind === "scalar") {
    allowed(source, typeBaseKeys, path);
    return { kind, ...base };
  }
  if (kind === "enum") {
    allowed(source, [...typeBaseKeys, "labels"], path);
    return { kind, ...base, labels: stringArray(source.labels, `${path}.labels`) };
  }
  if (kind === "domain") {
    allowed(source, [...typeBaseKeys, "baseTypeIdentity", "nullable", "checks"], path);
    return {
      kind,
      ...base,
      baseTypeIdentity: text(source.baseTypeIdentity, `${path}.baseTypeIdentity`),
      nullable: bool(source.nullable, `${path}.nullable`),
      checks: stringArray(source.checks, `${path}.checks`).map((item, index) =>
        fingerprint(item, `${path}.checks[${index}]`),
      ),
    };
  }
  if (kind === "composite") {
    allowed(source, [...typeBaseKeys, "fields"], path);
    if (!Array.isArray(source.fields)) throw new TypeError(`${path}.fields must be an array`);
    return {
      kind,
      ...base,
      fields: source.fields.map((item, index) => parseCompositeField(item, `${path}.fields[${index}]`)),
    };
  }
  if (kind === "range" || kind === "multirange") {
    allowed(source, [...typeBaseKeys, "subtypeIdentity"], path);
    return { kind, ...base, subtypeIdentity: text(source.subtypeIdentity, `${path}.subtypeIdentity`) };
  }
  if (kind === "collection") {
    allowed(source, [...typeBaseKeys, "elementTypeIdentity", "dimensions"], path);
    const dimensions =
      source.dimensions === undefined
        ? undefined
        : Array.isArray(source.dimensions)
          ? source.dimensions.map((item, index) => integer(item, `${path}.dimensions[${index}]`))
          : (() => {
              throw new TypeError(`${path}.dimensions must be an array`);
            })();
    const output: CollectionTypeSnapshot = {
      kind,
      ...base,
      elementTypeIdentity: text(source.elementTypeIdentity, `${path}.elementTypeIdentity`),
      ...(dimensions === undefined ? {} : { dimensions }),
    };
    return output;
  }
  allowed(source, [...typeBaseKeys, "reason"], path);
  return { kind, ...base, reason: text(source.reason, `${path}.reason`) };
}

function parseRoutineArgument(value: unknown, path: string): RoutineArgumentSnapshot {
  const source = record(value, path);
  allowed(source, ["name", "mode", "typeIdentity", "databaseType", "tsType", "default"], path);
  return {
    ...(source.name === undefined ? {} : { name: text(source.name, `${path}.name`) }),
    mode: oneOf(source.mode, ["in", "out", "inout", "variadic"], `${path}.mode`),
    typeIdentity: text(source.typeIdentity, `${path}.typeIdentity`),
    databaseType: text(source.databaseType, `${path}.databaseType`),
    tsType: text(source.tsType, `${path}.tsType`),
    default: oneOf(source.default, ["none", "present", "unknown"], `${path}.default`),
  };
}

function parseRoutineResult(value: unknown, path: string): RoutineResultSnapshot {
  const source = record(value, path);
  const kind = oneOf(source.kind, ["scalar", "set", "record", "table", "void", "command"], `${path}.kind`);
  if (kind === "scalar" || kind === "set") {
    allowed(source, ["kind", "typeIdentity", "databaseType", "tsType", "nullable"], path);
    return {
      kind,
      typeIdentity: text(source.typeIdentity, `${path}.typeIdentity`),
      databaseType: text(source.databaseType, `${path}.databaseType`),
      tsType: text(source.tsType, `${path}.tsType`),
      nullable: bool(source.nullable, `${path}.nullable`),
    };
  }
  if (kind === "record" || kind === "table") {
    allowed(source, ["kind", "columns"], path);
    return { kind, columns: objectMap(source.columns, `${path}.columns`, parseColumn) };
  }
  allowed(source, ["kind"], path);
  return { kind };
}

function parseRoutine(value: unknown, path: string): RoutineSnapshot {
  const source = record(value, path);
  allowed(
    source,
    [
      "name",
      "schema",
      "identity",
      "kind",
      "arguments",
      "result",
      "volatility",
      "deterministic",
      "dataAccess",
      "nullInput",
      "availableSince",
      "availableUntil",
      "polymorphicFamily",
      "extension",
    ],
    path,
  );
  if (!Array.isArray(source.arguments)) throw new TypeError(`${path}.arguments must be an array`);
  const extension = parseExtension(source.extension, `${path}.extension`);
  return {
    name: text(source.name, `${path}.name`),
    ...(source.schema === undefined ? {} : { schema: text(source.schema, `${path}.schema`) }),
    identity: text(source.identity, `${path}.identity`),
    kind: oneOf(source.kind, ["function", "procedure", "aggregate", "window"], `${path}.kind`),
    arguments: source.arguments.map((item, index) => parseRoutineArgument(item, `${path}.arguments[${index}]`)),
    result: parseRoutineResult(source.result, `${path}.result`),
    volatility: oneOf(source.volatility, ["immutable", "stable", "volatile", "unknown"], `${path}.volatility`),
    deterministic: booleanOrUnknown(source.deterministic, `${path}.deterministic`),
    dataAccess: oneOf(
      source.dataAccess,
      ["none", "contains-sql", "reads-sql", "modifies-sql", "unknown"],
      `${path}.dataAccess`,
    ),
    nullInput: oneOf(source.nullInput, ["strict", "called", "unknown"], `${path}.nullInput`),
    ...(source.availableSince === undefined
      ? {}
      : { availableSince: text(source.availableSince, `${path}.availableSince`) }),
    ...(source.availableUntil === undefined
      ? {}
      : { availableUntil: text(source.availableUntil, `${path}.availableUntil`) }),
    ...(source.polymorphicFamily === undefined
      ? {}
      : { polymorphicFamily: text(source.polymorphicFamily, `${path}.polymorphicFamily`) }),
    ...(extension === undefined ? {} : { extension }),
  };
}

function parseNamespace(value: unknown, path: string): NamespaceSnapshot {
  const source = record(value, path);
  allowed(source, ["name", "kind", "extension"], path);
  const extension = parseExtension(source.extension, `${path}.extension`);
  return {
    name: text(source.name, `${path}.name`),
    kind: oneOf(source.kind, ["catalog", "database", "schema"], `${path}.kind`),
    ...(extension === undefined ? {} : { extension }),
  };
}

function legacyColumn(column: ColumnSnapshotV2): ColumnSnapshot {
  return {
    name: column.name,
    databaseType: column.databaseType,
    tsType: column.tsType,
    nullable: column.nullable,
    ...(column.dimensions === undefined ? {} : { array: true }),
  };
}

function legacyViews(
  relations: SchemaSnapshotV2["relations"],
  types: SchemaSnapshotV2["types"],
  routines: SchemaSnapshotV2["routines"],
): Pick<SchemaSnapshotV2, "tables" | "enums" | "domains" | "functions"> {
  const tables: Record<string, TableSnapshot> = {};
  for (const [key, relation] of Object.entries(relations)) {
    tables[key] = {
      name: relation.name,
      ...(relation.schema === undefined ? {} : { schema: relation.schema }),
      columns: Object.fromEntries(
        Object.entries(relation.columns)
          .sort(([, left], [, right]) => left.position - right.position)
          .map(([columnKey, column]) => [columnKey, legacyColumn(column)]),
      ),
    };
  }
  const enums: Record<string, readonly string[]> = {};
  const domains: Record<string, DomainSnapshot> = {};
  for (const [key, type] of Object.entries(types)) {
    if (type.kind === "enum") enums[key] = type.labels;
    if (type.kind === "domain") {
      domains[key] = { name: type.name, databaseType: type.databaseType, tsType: type.tsType, nullable: type.nullable };
    }
  }
  const functions: Record<string, FunctionSnapshot> = {};
  for (const overloads of Object.values(routines)) {
    for (const routine of overloads) {
      if (routine.kind !== "function" && routine.kind !== "aggregate" && routine.kind !== "window") continue;
      const inputArguments = routine.arguments.filter(
        ({ mode }) => mode === "in" || mode === "inout" || mode === "variadic",
      );
      const result = routine.result;
      const databaseReturnType = result.kind === "scalar" || result.kind === "set" ? result.databaseType : result.kind;
      const returnType = result.kind === "scalar" || result.kind === "set" ? result.tsType : "unknown";
      const nullable = result.kind === "scalar" || result.kind === "set" ? result.nullable : true;
      const key = `${routine.schema === undefined ? "" : `${routine.schema}.`}${routine.name}(${inputArguments
        .map(({ databaseType }) => databaseType)
        .join(",")})`;
      functions[key] = {
        name: routine.name,
        ...(routine.schema === undefined ? {} : { schema: routine.schema }),
        argumentTypes: inputArguments.map(({ databaseType }) => databaseType),
        databaseReturnType,
        returnType,
        nullable,
        ...(result.kind === "set" ? { setReturning: true } : {}),
        ...(routine.volatility === "unknown" ? {} : { volatility: routine.volatility }),
      };
    }
  }
  return {
    tables,
    ...(Object.keys(enums).length === 0 ? {} : { enums }),
    ...(Object.keys(domains).length === 0 ? {} : { domains }),
    ...(Object.keys(functions).length === 0 ? {} : { functions }),
  };
}

/** Parses a strict canonical v2 envelope and adds transitional v1 resolver views in memory. */
export function parseSchemaSnapshotV2(value: unknown, compare = compareSchemaKeys): SchemaSnapshotV2 {
  const source = record(value, "schema");
  allowed(
    source,
    [
      "formatVersion",
      "dialect",
      "dialectVersion",
      "server",
      "namespaces",
      "types",
      "relations",
      "routines",
      "metadata",
      "extension",
    ],
    "schema",
  );
  if (source.formatVersion !== SCHEMA_FORMAT_VERSION) {
    throw new TypeError(`schema.formatVersion must be ${SCHEMA_FORMAT_VERSION}`);
  }
  const namespaces = objectMap(source.namespaces, "schema.namespaces", parseNamespace);
  const types = objectMap(source.types, "schema.types", parseType);
  const relations = objectMap(source.relations, "schema.relations", (item, path) => parseRelation(item, path, compare));
  const routineSource = record(source.routines, "schema.routines");
  const routines = Object.fromEntries(
    Object.keys(routineSource)
      .sort()
      .map((key) => {
        const overloads = routineSource[key];
        if (!Array.isArray(overloads)) throw new TypeError(`schema.routines.${key} must be an array`);
        return [
          key,
          overloads
            .map((item, index) => parseRoutine(item, `schema.routines.${key}[${index}]`))
            .sort((left, right) => compare(left.identity, right.identity)),
        ];
      }),
  );
  const extension = parseExtension(source.extension, "schema.extension");
  const metadata = parseMetadata(source.metadata, "schema.metadata");
  const server = parseDialectServerEvidence(source.server);
  return {
    formatVersion: SCHEMA_FORMAT_VERSION,
    dialect: text(source.dialect, "schema.dialect"),
    dialectVersion: text(source.dialectVersion, "schema.dialectVersion"),
    server,
    namespaces,
    types,
    relations,
    routines,
    ...(metadata === undefined ? {} : { metadata }),
    ...(extension === undefined ? {} : { extension }),
    version: server.version,
    ...legacyViews(relations, types, routines),
  };
}

/** Validates and canonicalizes a grammar-produced v2 envelope. */
export function defineSchemaSnapshotV2(value: SchemaSnapshotV2Envelope): SchemaSnapshotV2 {
  return parseSchemaSnapshotV2(value);
}

/** Removes transitional projections so v2 has one serialized source of truth. */
export function schemaSnapshotV2Envelope(snapshot: SchemaSnapshotV2): SchemaSnapshotV2Envelope {
  return {
    formatVersion: snapshot.formatVersion,
    dialect: snapshot.dialect,
    dialectVersion: snapshot.dialectVersion,
    server: snapshot.server,
    namespaces: snapshot.namespaces,
    types: snapshot.types,
    relations: snapshot.relations,
    routines: snapshot.routines,
    ...(snapshot.metadata === undefined ? {} : { metadata: snapshot.metadata }),
    ...(snapshot.extension === undefined ? {} : { extension: snapshot.extension }),
  };
}
