import { describe, it, strict } from "poku";
import { assertDialectPlugin, assertDialectProfile, DIALECT_CONTRACT_VERSION } from "../src/index.js";

const profile = {
  contractVersion: DIALECT_CONTRACT_VERSION,
  id: "vendor/profile",
  grammarVersion: "1",
  sqlModule: "vendor/profile",
  defaultTypePolicy: {},
  capabilities: {},
  placeholder: (index: number) => `?${index}`,
  quoteIdentifier: (name: string) => name,
  validateSnapshot: (snapshot: unknown) => snapshot,
};
await describe("lightweight grammar profile validation", async () => {
  await it("validates a profile independently of semantic analysis and never reads an analyzer getter", () => {
    strict.doesNotThrow(() => assertDialectProfile(profile));
    strict.doesNotThrow(() =>
      assertDialectProfile({
        ...profile,
        get analyze() {
          throw Error("analyzer loaded");
        },
      }),
    );
    strict.throws(() => assertDialectPlugin(profile), /dialect.analyze/u);
    strict.throws(() => assertDialectPlugin({ ...profile, analyze: null, validateSnapshot: null }), /dialect.analyze/u);
    strict.throws(() => assertDialectProfile({ ...profile, contractVersion: 0 }), /contract/u);
  });
  await it("rejects missing mechanics, invalid capabilities and incompatible optional hooks", () => {
    for (const invalid of [
      null,
      { ...profile, id: "" },
      { ...profile, grammarVersion: "" },
      { ...profile, placeholder: null },
      { ...profile, quoteIdentifier: null },
      { ...profile, validateSnapshot: null },
      { ...profile, capabilities: { z: true, a: true } },
      { ...profile, parameterOccurrences: false },
      { ...profile, runtimeSqlModule: "" },
      { ...profile, runtimeValueType: false },
      { ...profile, resolveCapabilities: false },
    ])
      strict.throws(() => assertDialectProfile(invalid));
  });
});
