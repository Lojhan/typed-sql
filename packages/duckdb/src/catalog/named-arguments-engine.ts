import { bindRoutineArguments } from "@typed-sql/core";
import { duckDBAsciiFold } from "../native-types.js";
import { type DuckDBCatalog, duckDBBuiltinParameterBindings } from "./profile.js";
import type { DuckDBBuiltinSignature } from "./types.js";

/** Native names bind slots; type selection and coercion remain in the DuckDB resolver. */
export function duckDBNamedArgumentOrder(
  catalog: DuckDBCatalog,
  name: string,
  names: readonly (string | undefined)[],
  quoted: boolean,
): { readonly order: readonly number[]; readonly signatures: ReadonlySet<DuckDBBuiltinSignature> } | undefined {
  const policy = catalog.namedArgumentBinding;
  if (!policy || (!quoted && catalog.keywordInvocationForms.includes(name) && !Object.hasOwn(policy.overrides, name)))
    return undefined;
  if ((policy.overrides as Readonly<Record<string, string>>)[name] === "labels")
    return { order: names.map((_, index) => index), signatures: new Set(catalog.builtinSignatures(name)) };
  const orders = new Map<string, number[]>();
  const signatures = new Set<DuckDBBuiltinSignature>();
  for (const signature of catalog.builtinSignatures(name)) {
    if (names.length < signature[2].length || (!signature[4] && names.length !== signature[2].length)) continue;
    const mode =
      (policy.overrides as Readonly<Record<string, string>>)[name] ??
      (signature[1] === "macro" ? policy.macro : policy.scalar);
    if (mode === "labels") {
      const order = names.map((_, index) => index);
      orders.set(JSON.stringify(order), order);
      signatures.add(signature);
      continue;
    }
    for (const alternative of duckDBBuiltinParameterBindings(signature)) {
      const slots = alternative.map((parameter) => ({
        ...(parameter.name === null || parameter.passing === "positional-only"
          ? {}
          : { name: duckDBAsciiFold(parameter.name) }),
        optional: parameter.optional,
        positional: parameter.passing !== "named-only",
        variadic: parameter.passing === "variadic-positional",
      }));
      const binding = bindRoutineArguments(
        slots,
        {
          argumentCount: names.length,
          names: names.map((name) => (name === undefined ? undefined : duckDBAsciiFold(name))),
          variadic: "expanded",
        },
        { positionalAfterNamed: false, expandedVariadicNames: true, minimumVariadicElements: 0 },
      );
      if (!binding) continue;
      const order = binding
        .map((slot, index) => ({ parameter: slot.parameterIndex, index }))
        .sort((a, b) => a.parameter - b.parameter || a.index - b.index)
        .map((slot) => slot.index);
      orders.set(JSON.stringify(order), order);
      signatures.add(signature);
    }
  }
  const order = orders.size === 1 ? orders.values().next().value : undefined;
  return order ? { order, signatures } : undefined;
}
