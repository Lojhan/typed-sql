import { assertGrammarConformance } from "@typed-sql/conformance";
import { runAdaptedGrammarConformanceV1 } from "@typed-sql/conformance/v2";
import { syntheticConformanceFixture } from "@typed-sql/example-synthetic-grammar/conformance";
import { describe, it, strict } from "poku";

await describe("synthetic third-party grammar", async () => {
  await it("passes through published typed-sql entrypoints only", () => {
    const report = assertGrammarConformance(syntheticConformanceFixture);
    strict.strictEqual(report.grammar, "synthetic");
    strict.strictEqual(report.structuralVariants, 2);
    strict.strictEqual(
      runAdaptedGrammarConformanceV1(syntheticConformanceFixture).every(({ status }) => status === "pass"),
      true,
    );
  });
});
