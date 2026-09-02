import { describe, it, strict } from "poku";
import { ConformanceInjectedFailure, createFailureInjector, INJECTED_FAILURE_CODE } from "../src/index.js";

await describe("deterministic failure injection", async () => {
  await it("injects the selected occurrence once and records a stable snapshot", async () => {
    const injector = createFailureInjector([{ point: "driver.execute", occurrence: 2 }]);
    strict.strictEqual(
      injector.run("driver.execute", () => "first"),
      "first",
    );
    await strict.rejects(
      injector.runAsync("driver.execute", async () => "second"),
      (error: unknown) =>
        error instanceof ConformanceInjectedFailure &&
        error.code === INJECTED_FAILURE_CODE &&
        error.point === "driver.execute" &&
        error.occurrence === 2,
    );
    strict.strictEqual(await injector.runAsync("driver.execute", async () => "third"), "third");
    strict.deepStrictEqual(injector.snapshot(), { hits: { "driver.execute": 3 }, remaining: [] });
  });

  await it("rejects malformed schedules before running component code", () => {
    strict.throws(() => createFailureInjector([{ point: "" }]), /non-empty/u);
    strict.throws(() => createFailureInjector([{ point: "driver.execute", occurrence: 0 }]), /positive/u);
  });
});
