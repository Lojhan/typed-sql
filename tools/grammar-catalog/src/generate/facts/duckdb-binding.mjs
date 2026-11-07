import { requireKnown } from "../../model/projection.mjs";

/** @typedef {import('@sinclair/typebox').Static<typeof import('../../model/schema.mjs').RoutineSchema>} Routine */
const typeIdentity = (type) => {
  if (type.kind === "native") return type.identity;
  if (type.kind === "unknown") return null;
  throw new TypeError(`Unrepresentable DuckDB binding type: ${type.kind}`);
};
/** Match overloads by semantic signature, never catalog iteration order or display names.
 * @param {string} name @param {Routine} routine
 */
export function duckdbBindingKey(name, routine) {
  const parameters = requireKnown(routine.parameters, `${name} parameters`);
  return JSON.stringify([
    name,
    requireKnown(routine.namespace, `${name} namespace`),
    requireKnown(routine.nativeKind, `${name} kind`),
    parameters
      .filter((parameter) => parameter.mode === "input" || parameter.mode === "named-only")
      .map((parameter) => typeIdentity(parameter.type)),
    typeIdentity(routine.result.type),
    typeIdentity(routine.variadicType),
  ]);
}
/** @param {Routine} routine */
export function duckdbSourceBinding(routine) {
  const parameters = requireKnown(routine.parameters, "DuckDB source parameters");
  if (parameters.some((parameter) => parameter.default.kind === "unknown"))
    throw new TypeError("Unqualified DuckDB source parameter defaults");
  const passing = parameters.map((parameter) => requireKnown(parameter.passing, "DuckDB source parameter passing"));
  // The current slot binder has no keyword-rest slot. Keep this projection gap explicit.
  if (passing.includes("variadic-named")) return { status: "unsupported", reason: "variadic-keyword-slot" };
  return {
    status: "known",
    parameters: parameters.map((parameter, index) => ({
      name: requireKnown(parameter.name, "DuckDB source parameter name"),
      passing: passing[index],
      optional:
        (parameter.default.kind !== "absent" && parameter.default.kind !== "unknown") ||
        passing[index] === "variadic-positional",
    })),
  };
}
