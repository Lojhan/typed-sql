/** Formal input slots after a grammar has classified modes and normalized names. */
export interface RoutineParameterSlot {
  readonly name?: string;
  readonly optional: boolean;
  readonly variadic?: boolean;
  readonly positional?: boolean;
}

export interface RoutineCallShape {
  readonly argumentCount: number;
  readonly names?: readonly (string | undefined)[];
  readonly variadic: "expanded" | "explicit";
}

/** Grammars supply invocation rules; core supplies only the slot assignment mechanics. */
export interface RoutineBindingPolicy {
  readonly positionalAfterNamed: boolean;
  readonly expandedVariadicNames: boolean;
  readonly minimumVariadicElements: number;
}

export interface RoutineArgumentBinding {
  readonly parameterIndex: number;
  readonly variadicElement: boolean;
}

/** Undefined means the call cannot bind. No types, casts, nullability or ranking are inferred. */
export function bindRoutineArguments(
  parameters: readonly RoutineParameterSlot[],
  call: RoutineCallShape,
  policy: RoutineBindingPolicy,
): readonly RoutineArgumentBinding[] | undefined {
  if (
    !Number.isSafeInteger(call.argumentCount) ||
    call.argumentCount < 0 ||
    !Number.isSafeInteger(policy.minimumVariadicElements) ||
    policy.minimumVariadicElements < 0 ||
    (call.names !== undefined && call.names.length !== call.argumentCount)
  )
    return undefined;
  const variadicIndex = parameters.findIndex((parameter) => parameter.variadic);
  if (variadicIndex !== -1 && variadicIndex !== parameters.length - 1) return undefined;
  const expanded = variadicIndex !== -1 && call.variadic === "expanded";
  if (call.variadic === "explicit" && variadicIndex === -1) return undefined;
  if (expanded && call.names !== undefined && !policy.expandedVariadicNames) return undefined;
  if (call.variadic === "explicit" && call.names === undefined && call.argumentCount !== parameters.length)
    return undefined;
  const used = new Set<number>(),
    bindings: RoutineArgumentBinding[] = [];
  let positional = 0,
    named = false,
    variadicElements = 0;
  for (let index = 0; index < call.argumentCount; index++) {
    const name = call.names?.[index];
    if (name === undefined && named && !policy.positionalAfterNamed) return undefined;
    let parameterIndex: number;
    if (name === undefined) {
      while (
        parameters[positional]?.positional === false ||
        (used.has(positional) && !(expanded && positional === variadicIndex))
      )
        positional++;
      parameterIndex = expanded && positional >= variadicIndex ? variadicIndex : positional++;
    } else {
      named = true;
      const matches = parameters.flatMap((parameter, slot) => (parameter.name === name ? [slot] : []));
      if (matches.length !== 1) return undefined;
      parameterIndex = matches[0]!;
    }
    const variadicElement = expanded && parameterIndex === variadicIndex;
    if (parameterIndex >= parameters.length || (used.has(parameterIndex) && (!variadicElement || name !== undefined)))
      return undefined;
    if (variadicElement) variadicElements++;
    used.add(parameterIndex);
    bindings.push({ parameterIndex, variadicElement });
  }
  if (
    expanded &&
    variadicElements < policy.minimumVariadicElements &&
    (variadicElements > 0 || !parameters[variadicIndex]!.optional)
  )
    return undefined;
  if (
    parameters.some(
      (parameter, index) =>
        !used.has(index) &&
        !parameter.optional &&
        !(expanded && index === variadicIndex && policy.minimumVariadicElements === 0),
    )
  )
    return undefined;
  return bindings;
}
