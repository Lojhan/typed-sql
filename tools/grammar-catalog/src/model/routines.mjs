import { hash } from "./canonical.mjs";

/** Capture envelope. Native adapters supply facts; this layer supplies structure only. */
export function routineSignature(mapper, row) {
  const facts = mapper.routineFacts(row);
  const namespace = row.namespace ?? row.schema_name ?? null;
  const parameters = facts.parameters ?? null,
    registration = facts.registration ?? false;
  const result = Object.hasOwn(facts, "result") ? facts.result : (row.result ?? null);
  const identity =
    row.identity ??
    (parameters === null && !registration
      ? `${namespace ?? ""}.${row.name}/name-only`
      : `${namespace ?? ""}.${row.name}/${row.kind ?? "unknown"}/${hash({
          parameters:
            parameters?.map((parameter) => ({
              type: parameter.nativeType,
              mode: parameter.mode,
              position: parameter.inputPosition,
              ...(parameter.mode === "named" ? { name: parameter.name } : {}),
            })) ?? null,
          variadic: row.variadic ?? row.varargs ?? Number(row.arity) === -1,
          arity: row.arity ?? null,
          encoding: row.encoding ?? null,
        })}`);
  return {
    formatVersion: 1,
    name: row.name,
    kind: row.kind ?? null,
    identity,
    identityKnowledge: registration
      ? "catalog-registration"
      : parameters === null
        ? "name-only"
        : (facts.identityKnowledge ?? "catalog-signature"),
    namespace,
    parameters,
    parameterKnowledge: parameters === null ? "unavailable" : (facts.parameterKnowledge ?? "catalog"),
    defaultExpressions: facts.defaultExpressions ?? null,
    defaultsKnowledge: facts.defaultsKnowledge ?? "unavailable",
    variadic:
      row.variadic ??
      (row.varargs != null
        ? true
        : Object.hasOwn(facts, "variadic")
          ? facts.variadic
          : parameters === null
            ? null
            : false),
    variadicNativeType: row.variadic_type ?? row.varargs ?? null,
    result: {
      nativeType: result,
      nativeMetadata: facts.resultMetadata ?? null,
      typeKnowledge: result === null ? (facts.unknownResultKnowledge ?? "unavailable") : "catalog-native-type",
      columns: facts.resultColumns ?? null,
      returnsSet: row.returns_set ?? facts.returnsSet ?? (row.kind === undefined ? null : false),
      nullable: null,
      nullabilityKnowledge: "unverified",
    },
    properties: {
      strict: row.strict ?? null,
      volatility: row.volatility ?? row.stability ?? null,
      sideEffects: row.side_effects ?? null,
      parallel: row.parallel ?? null,
      deterministic: row.deterministic ?? null,
      nativeFlags: row.flags ?? null,
      aliasOf: row.alias_of ?? null,
      macroDefinition: row.macro_definition ?? null,
    },
    policyRequired: [
      "coercions",
      "polymorphism",
      "result-nullability",
      "decoding",
      "special-syntax",
      "version-availability-between-captures",
    ],
  };
}
