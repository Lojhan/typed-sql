import { describe, it, strict } from "poku";
import { bindRoutineArguments, type RoutineBindingPolicy, type RoutineParameterSlot } from "../src/index.js";

const policy: RoutineBindingPolicy = {
  positionalAfterNamed: false,
  expandedVariadicNames: false,
  minimumVariadicElements: 1,
};
const slots: readonly RoutineParameterSlot[] = [
  { name: "first", optional: false },
  { name: "second", optional: true },
];
const call = (argumentCount: number, names?: readonly (string | undefined)[]) => ({
  argumentCount,
  ...(names === undefined ? {} : { names }),
  variadic: "expanded" as const,
});

await describe("grammar-neutral routine slot binding", async () => {
  await it("binds required/default slots and rejects missing, extra and unknown arguments", () => {
    strict.deepEqual(bindRoutineArguments(slots, call(1), policy), [{ parameterIndex: 0, variadicElement: false }]);
    strict.deepEqual(
      bindRoutineArguments(slots, call(2), policy)?.map((binding) => binding.parameterIndex),
      [0, 1],
    );
    strict.deepEqual(bindRoutineArguments([], call(0), policy), []);
    for (const shape of [call(0), call(3), call(-1), call(0.5), call(Infinity), call(1, []), call(1, ["absent"])])
      strict.equal(bindRoutineArguments(slots, shape, policy), undefined);
    strict.equal(bindRoutineArguments(slots, call(1), { ...policy, minimumVariadicElements: -1 }), undefined);
    strict.equal(bindRoutineArguments(slots, call(1), { ...policy, minimumVariadicElements: Infinity }), undefined);
    strict.equal(bindRoutineArguments(slots, { ...call(1), variadic: "explicit" }, policy), undefined);
    strict.equal(bindRoutineArguments(slots, call(1, ["second"]), policy), undefined);
  });

  await it("uses the grammar's named/positional policy without deciding SQL name semantics", () => {
    strict.deepEqual(
      bindRoutineArguments(slots, call(2, ["second", "first"]), policy)?.map((b) => b.parameterIndex),
      [1, 0],
    );
    strict.equal(bindRoutineArguments(slots, call(2, ["first", "first"]), policy), undefined);
    strict.equal(bindRoutineArguments(slots, call(2, ["second", undefined]), policy), undefined);
    strict.deepEqual(
      bindRoutineArguments(slots, call(2, ["second", undefined]), { ...policy, positionalAfterNamed: true })?.map(
        (b) => b.parameterIndex,
      ),
      [1, 0],
    );
    strict.deepEqual(
      bindRoutineArguments(slots, call(2, ["first", undefined]), { ...policy, positionalAfterNamed: true })?.map(
        (b) => b.parameterIndex,
      ),
      [0, 1],
    );
    strict.equal(bindRoutineArguments([slots[0]!, slots[0]!], call(1, ["first"]), policy), undefined);
  });

  await it("assigns variadic elements or the explicit formal slot under grammar-owned rules", () => {
    const variadic = [{ name: "values", optional: false, variadic: true }];
    strict.deepEqual(bindRoutineArguments(variadic, call(2), policy), [
      { parameterIndex: 0, variadicElement: true },
      { parameterIndex: 0, variadicElement: true },
    ]);
    strict.equal(bindRoutineArguments(variadic, call(0), policy), undefined);
    strict.deepEqual(bindRoutineArguments(variadic, call(0), { ...policy, minimumVariadicElements: 0 }), []);
    strict.deepEqual(bindRoutineArguments([{ ...variadic[0]!, optional: true }], call(0), policy), []);
    strict.equal(
      bindRoutineArguments([{ ...variadic[0]!, optional: true }], call(1), { ...policy, minimumVariadicElements: 2 }),
      undefined,
    );
    strict.equal(bindRoutineArguments(variadic, call(2), { ...policy, minimumVariadicElements: 2 })?.length, 2);
    strict.equal(bindRoutineArguments(variadic, call(1, [undefined]), policy), undefined);
    const named = { ...policy, expandedVariadicNames: true };
    strict.deepEqual(bindRoutineArguments(variadic, call(1, ["values"]), named), [
      { parameterIndex: 0, variadicElement: true },
    ]);
    strict.equal(bindRoutineArguments(variadic, call(2, ["values", "values"]), named), undefined);
    strict.deepEqual(bindRoutineArguments(variadic, { ...call(1), variadic: "explicit" }, policy), [
      { parameterIndex: 0, variadicElement: false },
    ]);
    strict.deepEqual(bindRoutineArguments(variadic, { ...call(1, ["values"]), variadic: "explicit" }, policy), [
      { parameterIndex: 0, variadicElement: false },
    ]);
    strict.equal(bindRoutineArguments(variadic, { ...call(2), variadic: "explicit" }, policy), undefined);
    strict.equal(bindRoutineArguments([...variadic, slots[0]!], call(2), policy), undefined);
    strict.deepEqual(
      bindRoutineArguments([slots[0]!, ...variadic], call(3), policy)?.map((b) => b.parameterIndex),
      [0, 1, 1],
    );
  });
});
