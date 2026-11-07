import { hash } from "./canonical.mjs";
import { describeEntity } from "./facets.mjs";
import { routineSignature } from "./routines.mjs";
import { CATALOG_SCHEMA_DIGEST, parseCatalog } from "./schema.mjs";

/** @template T @param {T} value @returns {{status: 'known', value: T}} */
export const known = (value) => ({ status: "known", value });
export const unknown = (reason) => ({ status: "unknown", reason });
const optional = (value, reason) => (value === null || value === undefined ? unknown(reason) : known(value));
const nativeType = (value, mapper) =>
  value === null || value === undefined
    ? { kind: "unknown", reason: "Native type is unavailable or dynamic" }
    : (mapper.typeExpression?.(value) ?? { kind: "native", identity: value });

function position(value) {
  if (value === null || value === undefined) return unknown("No ordinal is supplied for this parameter mode");
  if (
    (typeof value !== "number" && !(typeof value === "string" && /^\d+$/u.test(value))) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1
  )
    throw new TypeError("Invalid native parameter position");
  return known(Number(value));
}

/** Adapters classify native modes/types; an unfamiliar mode cannot become a required input optimistically. */
export function describeRoutine(signature, mapper) {
  const evidence = mapper.routineEvidence?.(signature) ?? {};
  return {
    identity: signature.identity,
    identityKnowledge: signature.identityKnowledge,
    namespace:
      signature.namespace === null && mapper.namespacePolicy !== "global"
        ? unknown("Native namespace is unavailable")
        : known(signature.namespace),
    nativeKind: optional(signature.kind, "Native routine kind is unavailable"),
    parameters:
      signature.parameters === null
        ? unknown("Formal parameter metadata is unavailable")
        : known(
            signature.parameters.map((parameter) => ({
              position: position(parameter.position),
              inputPosition: position(parameter.inputPosition),
              name: known(parameter.name ?? null),
              mode: mapper.parameterMode?.(parameter.mode) ?? "unknown",
              nativeMode: optional(parameter.mode, "Native parameter mode is unavailable"),
              type: nativeType(parameter.nativeType, mapper),
              default:
                parameter.hasDefault === false
                  ? { kind: "absent" }
                  : parameter.hasDefault === true
                    ? typeof parameter.defaultExpression === "string" && parameter.defaultExpression
                      ? { kind: "expression", sql: parameter.defaultExpression }
                      : { kind: "present-expression-unavailable" }
                    : { kind: "unknown", reason: "Native default availability is unverified" },
            })),
          ),
    variadic: optional(signature.variadic, "Native variadic behavior is unverified"),
    variadicType: nativeType(signature.variadicNativeType, mapper),
    defaultExpressions: optional(signature.defaultExpressions, "Individual default SQL expressions are unavailable"),
    result: {
      type: nativeType(signature.result.nativeType, mapper),
      columns:
        signature.result.columns === null
          ? unknown("Fixed result columns are unavailable")
          : known(
              signature.result.columns.map((column) => {
                const normalized = mapper.resultColumn?.(column) ?? column;
                return {
                  name: optional(normalized.name, "Native output column name is unavailable"),
                  type: nativeType(normalized.nativeType, mapper),
                  nullable: optional(normalized.nullable, "Native output nullability is unverified"),
                  native: column,
                };
              }),
            ),
      returnsSet: evidence.returnsSet ?? optional(signature.result.returnsSet, "Set-returning behavior is unverified"),
      nullable: optional(signature.result.nullable, "Result nullability is unverified"),
    },
    invocation: unknown("Invocation syntax requires source production evidence"),
    properties: signature.properties,
    requiredPolicy: signature.policyRequired,
  };
}

/**
 * Build normalized facts without selecting engines or importing their implementations.
 * @param {readonly {grammar: string, target: Record<string, unknown>, categories: Record<string, unknown>}[]} captures
 * @param {ReturnType<typeof import('../registry.mjs').createMapperRegistry>} registry
 * @param {{requiredCategories: readonly string[], normalizerDigest: string, inputDigest: string, sourceLocation: string}} options
 */
export function createCatalog(captures, registry, options) {
  const sources = {},
    entities = {},
    profiles = {};
  for (const capture of captures) {
    const mapper = registry.get(capture.grammar),
      target = mapper.reviewTarget?.(capture.target) ?? capture.target;
    const id = hash({ grammar: capture.grammar, target });
    if (Object.hasOwn(profiles, id)) throw new TypeError(`Duplicate catalog profile: ${id}`);
    const categories = {};
    for (const [category, inventory] of Object.entries(capture.categories)) {
      const { rows, ...metadata } = inventory;
      if (inventory.status === "unavailable") {
        categories[category] = { status: "unavailable", reason: inventory.reason, native: metadata };
        continue;
      }
      if (
        inventory.status !== "observed" ||
        !Array.isArray(rows) ||
        !rows.length ||
        hash(rows) !== inventory.fingerprint
      )
        throw new TypeError(`Invalid native inventory for ${capture.grammar}/${category}`);
      const source = {
        kind: "native-capture",
        location: `${options.sourceLocation}#/${id}/${category}`,
        revision: typeof target.version === "string" ? known(target.version) : unknown("Engine version unavailable"),
        contentDigest: inventory.fingerprint,
        digestFormat: "canonical-json-sha256",
        extractor: unknown("The original capture does not identify its extractor revision"),
        license: unknown("Capture does not declare upstream licensing metadata"),
        native: { ...metadata, grammar: capture.grammar, target },
      };
      const sourceId = hash(source);
      sources[sourceId] = source;
      const entries = rows.map((raw) => {
        const normalized = mapper.normalizeRow(category, raw);
        if (typeof normalized.name !== "string" || !normalized.name.trim())
          throw new TypeError("Missing catalog entity name");
        const signature = category === "functions" ? routineSignature(mapper, normalized) : undefined;
        const native = signature ? { ...normalized, signature } : normalized;
        const logical = signature
          ? { identity: signature.identity, knowledge: signature.identityKnowledge }
          : (mapper.entityIdentity?.(category, native) ?? { identity: hash(native), knowledge: "row-content" });
        const entity = {
          grammar: capture.grammar,
          category,
          name: native.name,
          identity: logical.identity,
          identityKnowledge: logical.knowledge,
          availability: { kind: "always" },
          native,
          semantic: describeEntity(category, native.name, mapper.entityFacts?.(category, native)),
          ...(signature ? { routine: describeRoutine(signature, mapper) } : {}),
        };
        const entityId = hash(entity);
        entities[entityId] = entity;
        return { entity: entityId, rawRow: hash(raw) };
      });
      categories[category] = {
        status: "observed",
        source: sourceId,
        originalFingerprint: inventory.fingerprint,
        entries,
        native: metadata,
      };
    }
    profiles[id] = {
      grammar: capture.grammar,
      version: target.version,
      band: mapper.versionBand(target.version),
      target,
      categories,
    };
  }
  return parseCatalog({
    formatVersion: 2,
    schemaDigest: CATALOG_SCHEMA_DIGEST,
    normalizerDigest: options.normalizerDigest,
    inputDigest: options.inputDigest,
    requiredCategories: [...options.requiredCategories],
    sources,
    entities,
    profiles,
  });
}
