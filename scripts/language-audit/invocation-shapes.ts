import type { builtinMappers } from "../../tools/grammar-catalog/src/mappers/index.mjs";
import { describeRoutine } from "../../tools/grammar-catalog/src/model/build.mjs";
import { routineSignature } from "../../tools/grammar-catalog/src/model/routines.mjs";
import type { parseCatalog } from "../../tools/grammar-catalog/src/model/schema.mjs";
import { parseRoutine } from "../../tools/grammar-catalog/src/model/schema.mjs";
import { hash } from "./inventory.mjs";
import type { DiscoveredFunction } from "./invocations.js";
import { spellingVariants } from "./spellings.js";

type Routine = NonNullable<ReturnType<typeof parseCatalog>["entities"][string]["routine"]>;
export interface InvocationShapeSyntax {
  call(row: DiscoveredFunction, args: readonly string[]): string | undefined;
  named(name: string, value: string): string;
  parameterRoleLimitation?(row: DiscoveredFunction): string | undefined;
  rejection(reason: string): "binding" | "value" | "unclassified";
  value(type: Routine["result"]["type"], mode: string): string | undefined;
}
export interface InvocationShapeCase {
  id: string;
  kind: string;
  sql: string;
  control?: string;
  role: "control" | "mutation";
}
export interface InvocationShapePlan {
  identity: string;
  routine: Routine;
  cases: InvocationShapeCase[];
  gaps: string[];
}

/** Structural cases derive from normalized metadata. Syntax and native type spelling belong to owners. */
export function planInvocationShapes(
  row: DiscoveredFunction,
  mapper: ReturnType<typeof builtinMappers.get>,
  syntax: InvocationShapeSyntax,
): InvocationShapePlan {
  const normalized = mapper.normalizeRow("functions", row);
  const routine = parseRoutine(describeRoutine(routineSignature(mapper, normalized), mapper));
  const plan: InvocationShapePlan = { identity: routine.identity, routine, cases: [], gaps: [] };
  if (routine.parameters.status !== "known") {
    plan.gaps.push("formal-parameters-unavailable");
    return plan;
  }
  const limitation = syntax.parameterRoleLimitation?.(row);
  if (limitation) plan.gaps.push(limitation);
  const inputs = routine.parameters.value.filter((parameter) =>
    ["input", "inout", "variadic"].includes(parameter.mode),
  );
  const options = routine.parameters.value.filter((parameter) => parameter.mode === "named-only");
  if (routine.parameters.value.some((parameter) => parameter.mode === "unknown")) {
    plan.gaps.push("parameter-mode-unavailable");
    return plan;
  }
  if (inputs.length > 128) {
    plan.gaps.push(`argument-count-over-probe-limit:${inputs.length}`);
    return plan;
  }
  const args: string[] = [];
  for (const [index, parameter] of inputs.entries()) {
    if (parameter.inputPosition.status !== "known" || parameter.inputPosition.value !== index + 1) {
      plan.gaps.push("input-ordinals-unavailable-or-noncontiguous");
      return plan;
    }
    const value = syntax.value(parameter.type, parameter.mode);
    if (value === undefined) {
      plan.gaps.push(`argument-type-not-renderable:${index + 1}`);
      return plan;
    }
    args.push(value);
  }
  const spellings = spellingVariants(row.name);
  const add = (
    kind: string,
    values: readonly string[],
    control?: string,
    role: "control" | "mutation" = control ? "mutation" : "control",
    callee = row.name,
  ): string | undefined => {
    const sql = syntax.call(
      {
        ...row,
        name: callee,
        ...(routine.namespace.status === "known" && routine.namespace.value !== null
          ? { namespace: routine.namespace.value }
          : {}),
      },
      values,
    );
    if (sql === undefined) {
      plan.gaps.push(`invocation-form-unavailable:${kind}`);
      return undefined;
    }
    const id = hash({ kind, sql });
    if (!plan.cases.some((entry) => entry.id === id))
      plan.cases.push({ id, kind, sql, role, ...(control ? { control } : {}) });
    if (role === "control")
      for (const variant of spellings) add(`function-name-${variant.kind}`, values, id, "mutation", variant.spelling);
    return id;
  };
  const positional = add("positional-control", args);
  if (positional) {
    if (args.length) add("omit-trailing-argument", args.slice(0, -1), positional);
    add("append-argument", [...args, "NULL"], positional);
  }
  if (routine.variadic.status === "known" && routine.variadic.value) {
    const value = syntax.value(routine.variadicType, "expanded-variadic");
    if (value === undefined) plan.gaps.push("expanded-variadic-type-unavailable");
    else {
      add("expanded-variadic-control", [...args, value]);
      if (inputs.length === 0) {
        const field = syntax.named("typed_sql_audit_field", value);
        const control = add("named-expanded-control", [field]);
        if (control) add("duplicate-expanded-argument-name", [field, field], control);
      }
    }
  }
  const names = inputs.map((parameter) => (parameter.name.status === "known" ? parameter.name.value : null));
  const lastUnknown = names.lastIndexOf(null);
  if (names.length && lastUnknown < names.length - 1) {
    const named = args.map((value, index) => (index <= lastUnknown ? value : syntax.named(names[index]!, value)));
    const control = add("named-control", named, positional, "control");
    if (control) {
      let unknown = "typed_sql_audit_unknown_parameter";
      while (names.some((name) => name?.toLowerCase() === unknown.toLowerCase())) unknown += "_";
      const changed = [...named];
      changed[changed.length - 1] = syntax.named(unknown, args.at(-1)!);
      add("unknown-argument-name", changed, control);
      if (lastUnknown === -1 && named.length > 1) add("reverse-named-arguments", [...named].reverse(), control);
      if (lastUnknown < names.length - 2) {
        const duplicate = [...named];
        duplicate[duplicate.length - 1] = syntax.named(names[lastUnknown + 1]!, args.at(-1)!);
        add("duplicate-argument-name", duplicate, control);
        const positionalAfterNamed = [...named];
        positionalAfterNamed[positionalAfterNamed.length - 1] = args.at(-1)!;
        add("positional-after-named", positionalAfterNamed, control);
      } else if (routine.variadic.status === "known" && routine.variadic.value) {
        add("duplicate-expanded-argument-name", [...named, named.at(-1)!], control);
      }
    }
  } else if (inputs.length) plan.gaps.push("named-formal-suffix-unavailable");
  for (const parameter of options) {
    if (parameter.name.status !== "known" || parameter.name.value === null) {
      plan.gaps.push("named-option-spelling-unavailable");
      continue;
    }
    const value = syntax.value(parameter.type, parameter.mode);
    if (value === undefined) {
      plan.gaps.push(`named-option-type-not-renderable:${parameter.name.value}`);
      continue;
    }
    const control = add(
      "named-option-control",
      [...args, syntax.named(parameter.name.value, value)],
      positional,
      "control",
    );
    if (control)
      add(
        "unknown-option-name",
        [...args, syntax.named(`typed_sql_audit_unknown_option_${parameter.name.value}`, value)],
        control,
      );
  }
  return plan;
}
