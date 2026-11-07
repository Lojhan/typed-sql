import { requireKnown } from "../../model/projection.mjs";

/** @typedef {import('@sinclair/typebox').Static<typeof import('../../model/schema.mjs').RoutineSchema>} Routine */
/** @typedef {{name: string, routine?: Routine}} RoutineEntity */
/** @param {import('@sinclair/typebox').Static<typeof import('../../model/schema.mjs').TypeExpressionSchema>} expression @param {string} label */
const nullableType = (expression, label) => {
  if (expression.kind === "native") return expression.identity;
  if (expression.kind === "unknown") return null;
  throw new TypeError(`Unsupported DuckDB runtime type expression: ${label}/${expression.kind}`);
};
/** @param {Routine} routine @param {string} key @param {'string' | 'boolean'} kind */
function nullableProperty(routine, key, kind) {
  const value = routine.properties[key];
  if (!Object.hasOwn(routine.properties, key) || (value !== null && typeof value !== kind))
    throw new TypeError(`Unqualified DuckDB routine property: ${key}`);
  return value;
}
/** @param {RoutineEntity} entity */
function routineParameters(entity) {
  if (!entity.routine) throw new TypeError(`Missing DuckDB routine facts: ${entity.name}`);
  const parameters = requireKnown(entity.routine.parameters, `${entity.name} parameters`);
  const positional = [],
    named = [];
  for (const parameter of parameters) {
    if (parameter.mode === "named-only") {
      if (requireKnown(parameter.name, `${entity.name} named parameter`) === null)
        throw new TypeError(`Missing DuckDB named-parameter spelling: ${entity.name}`);
      named.push(parameter);
    } else if (parameter.mode === "input") {
      const position = requireKnown(parameter.inputPosition, `${entity.name} input ordinal`);
      if (position !== positional.length + 1) throw new TypeError(`Noncontiguous DuckDB parameters: ${entity.name}`);
      positional.push(parameter);
    } else throw new TypeError(`Unsupported DuckDB parameter mode: ${entity.name}/${parameter.mode}`);
  }
  return { routine: entity.routine, positional, named };
}

/** Project validated routine facts; explicit unknown types stay null, richer expressions fail closed.
 * @param {RoutineEntity} entity
 * @param {readonly {name: string, semantics: string, parameters: string[]}[]} macroPolicy
 * @returns {readonly [string, string, (string | null)[], string | null, string | null, string | null, boolean | null]}
 */
export function duckdbSemanticSignature(entity, macroPolicy = []) {
  const { routine, positional } = routineParameters(entity);
  const kind = requireKnown(routine.nativeKind, `${entity.name} kind`);
  const override = kind === "macro" ? macroPolicy.find((entry) => entry.name === entity.name) : undefined;
  if (override && (override.semantics !== "specialized-resolver" || override.parameters.length !== positional.length))
    throw new TypeError(`Macro policy conflicts with native shape: ${entity.name}`);
  const varargs = nullableType(routine.variadicType, `${entity.name} varargs`);
  const variadic = requireKnown(routine.variadic, `${entity.name} variadic behavior`);
  if (variadic !== (varargs !== null))
    throw new TypeError(`Missing or contradictory DuckDB variadic type: ${entity.name}`);
  return [
    entity.name,
    kind,
    override?.parameters ?? positional.map((parameter) => nullableType(parameter.type, entity.name)),
    nullableType(routine.result.type, `${entity.name} result`),
    varargs,
    /** @type {string | null} */ (nullableProperty(routine, "volatility", "string")),
    /** @type {boolean | null} */ (nullableProperty(routine, "sideEffects", "boolean")),
  ];
}

/** Account for facts the legacy public tuple cannot express; this is not qualification.
 * @param {RoutineEntity} entity
 */
export function duckdbRoutineProjection(entity) {
  const { routine, positional, named } = routineParameters(entity);
  const parameters = [...positional, ...named];
  return {
    identity: routine.identity,
    name: entity.name,
    runtimeFormat: "seven-field-tuple-with-generated-formal-name-index",
    positionalParameters: positional.length,
    namedOnlyParameters: named.length,
    knownParameterNames: parameters.filter(
      (parameter) => parameter.name.status === "known" && parameter.name.value !== null,
    ).length,
    knownDefaults: parameters.filter((parameter) => parameter.default.kind !== "unknown").length,
    unknownDefaults: parameters.filter((parameter) => parameter.default.kind === "unknown").length,
    outputColumns: routine.result.columns.status === "known" ? routine.result.columns.value.length : null,
    unresolvedParameterTypes: positional.filter((parameter) => parameter.type.kind === "unknown").length,
    unresolvedResultType: routine.result.type.kind === "unknown",
    modelFactsAbsentFromRuntime: [
      "named-only-parameters",
      "parameter-defaults",
      "result-columns",
      "nullability-evidence",
      "invocation-evidence",
      "availability-conditions",
    ],
  };
}

/** @param {RoutineEntity} entity */
export function duckdbFormalNames(entity) {
  return routineParameters(entity).positional.map((parameter) =>
    requireKnown(parameter.name, `${entity.name} parameter name`),
  );
}
