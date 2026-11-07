import { Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { CaptureProvenanceSchema, parseCaptureProvenance } from "../provenance/capture.mjs";
import { hash } from "./canonical.mjs";
import { facetKinds } from "./facets.mjs";
import { assertJson } from "./json.mjs";

/** @template {import('@sinclair/typebox').TProperties} T @param {T} fields @param {string} [id] */
const object = (fields, id) =>
  Type.Object(fields, { additionalProperties: false, ...(id === undefined ? {} : { $id: id }) });
/** @template {string} T @param {T[]} values */
const enumeration = (values) => Type.Union(values.map((value) => Type.Literal(value)));
const text = Type.String({ minLength: 1, pattern: "\\S" });
export const DigestSchema = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });

export const JsonSchema = Type.Recursive(
  (self) =>
    Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(self),
      Type.Record(Type.String(), self),
    ]),
  { $id: "CatalogJson" },
);
const jsonObject = Type.Record(Type.String(), Type.Ref(JsonSchema));
const unknown = object({ status: Type.Literal("unknown"), reason: text });
/** @template {import('@sinclair/typebox').TSchema} T @param {T} schema */
export const fact = (schema) => Type.Union([object({ status: Type.Literal("known"), value: schema }), unknown]);

export const TypeExpressionSchema = Type.Recursive(
  (self) =>
    Type.Union([
      object({ kind: Type.Literal("native"), identity: text }),
      object({ kind: Type.Literal("variable"), name: text, constraints: Type.Array(text) }),
      object({ kind: Type.Literal("apply"), constructor: text, arguments: Type.Array(self), modifiers: jsonObject }),
      object({ kind: Type.Literal("row"), columns: Type.Array(object({ name: text, type: self })) }),
      object({ kind: Type.Literal("alternatives"), choices: Type.Array(self, { minItems: 1 }) }),
      object({ kind: Type.Literal("unknown"), reason: text }),
    ]),
  { $id: "CatalogTypeExpression" },
);

export const AvailabilitySchema = Type.Recursive(
  (self) =>
    Type.Union([
      object({ kind: Type.Literal("always") }),
      object({ kind: enumeration(["all", "any"]), conditions: Type.Array(self, { minItems: 1 }) }),
      object({ kind: Type.Literal("not"), condition: self }),
      object({
        kind: Type.Literal("predicate"),
        key: text,
        operator: enumeration(["equals", "contains", "at-least", "before"]),
        value: Type.Ref(JsonSchema),
      }),
    ]),
  { $id: "CatalogAvailability" },
);

const parameter = object({
  position: fact(Type.Integer({ minimum: 1 })),
  inputPosition: fact(Type.Integer({ minimum: 1 })),
  name: fact(Type.Union([text, Type.Null()])),
  mode: enumeration(["input", "output", "inout", "variadic", "named-only", "unknown"]),
  nativeMode: fact(text),
  type: Type.Ref(TypeExpressionSchema),
  default: Type.Union([
    object({ kind: enumeration(["absent", "present-expression-unavailable"]) }),
    object({ kind: Type.Literal("expression"), sql: text }),
    object({ kind: Type.Literal("unknown"), reason: text }),
  ]),
});
const column = object({
  name: fact(text),
  type: Type.Ref(TypeExpressionSchema),
  nullable: fact(Type.Boolean()),
  native: jsonObject,
});

export const RoutineSchema = object(
  {
    identity: text,
    identityKnowledge: text,
    namespace: fact(Type.Union([text, Type.Null()])),
    nativeKind: fact(text),
    parameters: fact(Type.Array(parameter)),
    variadic: fact(Type.Boolean()),
    variadicType: Type.Ref(TypeExpressionSchema),
    defaultExpressions: fact(text),
    result: object({
      type: Type.Ref(TypeExpressionSchema),
      columns: fact(Type.Array(column)),
      returnsSet: fact(Type.Boolean()),
      nullable: fact(Type.Boolean()),
    }),
    invocation: fact(object({ kind: enumeration(["call", "special-syntax"]), production: Type.Optional(text) })),
    properties: jsonObject,
    requiredPolicy: Type.Array(text, { uniqueItems: true }),
  },
  "CatalogRoutine",
);

const facetText = fact(text),
  facetBoolean = fact(Type.Boolean()),
  facetInteger = fact(Type.Integer());
export const SemanticFacetSchema = Type.Union([
  object({ kind: Type.Literal("unknown"), reason: text }),
  object({ kind: Type.Literal("routine") }),
  object({ kind: Type.Literal("keyword"), spelling: text, reserved: facetBoolean, nativeCategory: facetText }),
  object({
    kind: Type.Literal("type"),
    canonical: Type.Ref(TypeExpressionSchema),
    nativeKind: facetText,
    category: facetText,
    defined: facetBoolean,
    preferred: facetBoolean,
    storageIdentity: facetText,
    dimensions: object({ maxLength: facetInteger, precision: facetInteger, scale: facetInteger }),
  }),
  object({
    kind: Type.Literal("operator"),
    operands: fact(Type.Array(Type.Ref(TypeExpressionSchema))),
    result: Type.Ref(TypeExpressionSchema),
    fixity: fact(enumeration(["prefix", "infix", "postfix"])),
  }),
  object({
    kind: Type.Literal("cast"),
    from: Type.Ref(TypeExpressionSchema),
    to: Type.Ref(TypeExpressionSchema),
    context: fact(enumeration(["implicit", "assignment", "explicit"])),
    method: facetText,
  }),
  object({
    kind: Type.Literal("collation"),
    provider: facetText,
    encoding: facetInteger,
    characterSet: facetText,
    isDefault: facetBoolean,
  }),
  object({
    kind: Type.Literal("setting"),
    valueType: facetText,
    context: facetText,
    scope: facetText,
    enumValues: fact(Type.Array(Type.String())),
    minimum: facetInteger,
    maximum: facetInteger,
    dynamic: facetBoolean,
  }),
  object({ kind: Type.Literal("extension"), defaultVersion: facetText, installed: facetBoolean }),
  object({ kind: Type.Literal("syntax"), production: facetText }),
]);

export const EntitySchema = object(
  {
    grammar: text,
    category: text,
    name: text,
    identity: text,
    identityKnowledge: text,
    availability: Type.Ref(AvailabilitySchema),
    native: jsonObject,
    semantic: SemanticFacetSchema,
    routine: Type.Optional(Type.Ref(RoutineSchema)),
  },
  "CatalogEntity",
);

export const SourceSchema = object(
  {
    kind: enumeration(["native-capture", "vendor-source", "official-reference", "reviewed-policy"]),
    location: text,
    revision: fact(text),
    contentDigest: DigestSchema,
    digestFormat: enumeration(["canonical-json-sha256", "bytes-sha256"]),
    extractor: fact(object({ id: text, revision: text })),
    license: fact(text),
    provenance: Type.Optional(CaptureProvenanceSchema),
    native: jsonObject,
  },
  "CatalogSource",
);

const observed = object({
  status: Type.Literal("observed"),
  source: DigestSchema,
  originalFingerprint: DigestSchema,
  entries: Type.Array(object({ entity: DigestSchema, rawRow: DigestSchema }), { minItems: 1 }),
  native: jsonObject,
});
const unavailable = object({ status: Type.Literal("unavailable"), reason: text, native: jsonObject });

export const ProfileSchema = object(
  {
    grammar: text,
    version: text,
    band: text,
    target: jsonObject,
    categories: Type.Record(text, Type.Union([observed, unavailable]), {
      additionalProperties: false,
      minProperties: 1,
    }),
  },
  "CatalogProfile",
);

export const CatalogSchema = object({
  formatVersion: Type.Literal(2),
  schemaDigest: DigestSchema,
  normalizerDigest: DigestSchema,
  inputDigest: DigestSchema,
  requiredCategories: Type.Array(text, { minItems: 1, uniqueItems: true }),
  sources: Type.Record(DigestSchema, Type.Ref(SourceSchema), { additionalProperties: false }),
  entities: Type.Record(DigestSchema, Type.Ref(EntitySchema), { additionalProperties: false }),
  profiles: Type.Record(DigestSchema, Type.Ref(ProfileSchema), { additionalProperties: false, minProperties: 1 }),
});

const references = [
  JsonSchema,
  TypeExpressionSchema,
  AvailabilitySchema,
  RoutineSchema,
  EntitySchema,
  SourceSchema,
  ProfileSchema,
];
/** @type {import('@sinclair/typebox').TSchema & {$schema: string, definitions: Record<string, import('@sinclair/typebox').TSchema>}} */
export const CATALOG_SCHEMA_DOCUMENT = {
  $schema: "http://json-schema.org/draft-07/schema#",
  ...CatalogSchema,
  definitions: Object.fromEntries(references.map((schema) => [schema.$id, schema])),
};
export const CATALOG_SCHEMA_DIGEST = hash(CATALOG_SCHEMA_DOCUMENT);
const checker = TypeCompiler.Compile(CatalogSchema, references);

/**
 * Validates shape AND content-addressed references. No engine names or inference policies.
 * @param {unknown} value
 * @returns {import('@sinclair/typebox').Static<typeof CatalogSchema>}
 */
export function parseCatalog(value) {
  assertJson(value);
  if (!checker.Check(value)) {
    const error = checker.Errors(value).First();
    throw new TypeError(`Invalid catalog model at ${error?.path ?? "/"}: ${error?.message ?? "invalid shape"}`);
  }
  if (value.schemaDigest !== CATALOG_SCHEMA_DIGEST) throw new TypeError("Catalog schema digest differs");
  for (const [name, collection] of Object.entries({ sources: value.sources, entities: value.entities }))
    for (const [id, entry] of Object.entries(collection))
      if (hash(entry) !== id) throw new TypeError(`Catalog ${name} digest differs: ${id}`);
  for (const source of Object.values(value.sources)) {
    if (source.provenance) {
      const provenance = parseCaptureProvenance(source.provenance);
      if (
        source.kind !== "native-capture" ||
        source.extractor.status !== "known" ||
        source.extractor.value.id !== provenance.extractor.id ||
        source.extractor.value.revision !== provenance.extractor.revision
      )
        throw new TypeError("Catalog extractor evidence differs from native provenance");
    } else if (source.kind === "native-capture" && source.extractor.status === "known")
      throw new TypeError("Native extractor claim lacks provenance");
  }
  const usedEntities = new Set(),
    usedSources = new Set();
  for (const [id, profile] of Object.entries(value.profiles)) {
    if (id !== hash({ grammar: profile.grammar, target: profile.target }) || profile.target.version !== profile.version)
      throw new TypeError(`Catalog profile identity differs: ${id}`);
    for (const category of value.requiredCategories)
      if (!Object.hasOwn(profile.categories, category)) throw new TypeError(`Missing catalog category: ${category}`);
    for (const [category, capture] of Object.entries(profile.categories)) {
      if (capture.status === "unavailable") continue;
      if (!value.sources[capture.source]) throw new TypeError(`Missing catalog source: ${capture.source}`);
      const source = value.sources[capture.source];
      if (
        source.kind === "native-capture" &&
        (source.contentDigest !== capture.originalFingerprint ||
          source.native.grammar !== profile.grammar ||
          source.native.target === undefined ||
          hash(source.native.target) !== hash(profile.target))
      )
        throw new TypeError(`Incompatible native source evidence: ${capture.source}`);
      usedSources.add(capture.source);
      const rawRows = new Set();
      for (const entry of capture.entries) {
        const entity = value.entities[entry.entity];
        if (!entity || entity.grammar !== profile.grammar || entity.category !== category)
          throw new TypeError(`Missing or incompatible catalog entity: ${entry.entity}`);
        if (entity.semantic.kind !== (facetKinds[category] ?? "unknown"))
          throw new TypeError(`Incompatible semantic facet: ${entity.name}`);
        if (entity.category === "functions" && !entity.routine)
          throw new TypeError(`Missing routine facts: ${entity.name}`);
        if (rawRows.has(entry.rawRow)) throw new TypeError(`Duplicate native row accounting: ${entry.rawRow}`);
        rawRows.add(entry.rawRow);
        usedEntities.add(entry.entity);
      }
    }
  }
  if (
    usedEntities.size !== Object.keys(value.entities).length ||
    usedSources.size !== Object.keys(value.sources).length
  )
    throw new TypeError("Catalog contains orphaned entities or sources");
  return value;
}
