import { describe, it, strict } from "poku";
import {
  applyDialectCapabilityStates,
  defineDialectCapabilityStates,
  defineDialectServerEvidence,
  dialectCapabilityIssues,
  parseDialectServerEvidence,
  resolveDialectCapabilityStates,
  staticDialectCapabilityStates,
  unknownQuerySemantics,
} from "../src/index.js";

await describe("versioned dialect capabilities", async () => {
  await it("canonicalizes and deeply freezes non-secret server evidence", () => {
    const evidence = defineDialectServerEvidence({
      product: "example",
      version: "Example 4.2.1",
      versionKey: "4.2.1",
      features: ["zeta", "alpha"],
      settings: { strict: true, compatibility: "standard", maximumDepth: 100 },
    });
    strict.deepStrictEqual(evidence.features, ["alpha", "zeta"]);
    strict.deepStrictEqual(Object.keys(evidence.settings), ["compatibility", "maximumDepth", "strict"]);
    strict.ok(Object.isFrozen(evidence));
    strict.ok(Object.isFrozen(evidence.features));
    strict.ok(Object.isFrozen(evidence.settings));
  });

  await it("canonicalizes exact, conservative, and unsupported states", () => {
    const states = defineDialectCapabilityStates(
      {
        returning: {
          level: "exact",
          reason: "The selected server supports returning rows.",
          since: "4.0.0",
          evidence: [
            { kind: "server-version", key: "version", value: "4.2.1" },
            { kind: "grammar", key: "grammarVersion", value: "2.0.0" },
          ],
        },
        windows: {
          level: "conservative",
          reason: "Frame exclusion metadata is incomplete.",
          evidence: [{ kind: "policy", key: "unknownFrames", value: "conservative" }],
        },
      },
      ["returning", "windows"],
    );
    strict.deepStrictEqual(Object.keys(states), ["returning", "windows"]);
    strict.deepStrictEqual(
      states.returning?.evidence.map(({ kind }) => kind),
      ["grammar", "server-version"],
    );
    strict.ok(Object.isFrozen(states.returning?.evidence));
  });

  await it("provides conservative states for legacy boolean grammars", () => {
    const states = resolveDialectCapabilityStates(
      { grammarVersion: "1.0.0", capabilities: { returning: true, windows: false } },
      {},
    );
    strict.strictEqual(states.returning?.level, "conservative");
    strict.strictEqual(states.windows?.level, "unsupported");
  });

  await it("requires server evidence before static states become exact", () => {
    const states = staticDialectCapabilityStates({ returning: true, windows: false }, "2.0.0");
    strict.strictEqual(states.returning?.level, "conservative");
    strict.strictEqual(states.returning?.diagnostic, "TSQ402");
    strict.strictEqual(states.windows?.level, "unsupported");
    strict.strictEqual(states.windows?.diagnostic, "TSQ401");
    const exact = staticDialectCapabilityStates(
      { returning: true },
      "2.0.0",
      defineDialectServerEvidence({
        product: "example",
        version: "4.2.1",
        versionKey: "4.2.1",
        features: [],
        settings: {},
      }),
    );
    strict.strictEqual(exact.returning?.level, "exact");
  });

  await it("fails undeclared and non-exact requirements closed", () => {
    const states = staticDialectCapabilityStates(
      { returning: true },
      "2.0.0",
      defineDialectServerEvidence({
        product: "example",
        version: "4.2.1",
        versionKey: "4.2.1",
        features: [],
        settings: {},
      }),
    );
    const issues = dialectCapabilityIssues(["returning", "vendorExtension"], states);
    strict.deepStrictEqual(
      issues.map(({ capability }) => capability),
      ["vendorExtension"],
    );
    strict.strictEqual(issues[0]?.state.diagnostic, "TSQ406");
    strict.ok(Object.isFrozen(issues));
  });

  await it("rejects mismatched declarations and unsafe evidence", () => {
    strict.throws(
      () =>
        defineDialectServerEvidence({
          product: "example",
          version: "1",
          versionKey: "1",
          features: [],
          settings: { password: "redacted" },
        }),
      /secret connection material/u,
    );
    strict.throws(
      () =>
        defineDialectServerEvidence({
          product: "example",
          version: "1",
          versionKey: "1",
          features: [],
          settings: { mode: "postgresql://user:secret@localhost/db" },
        }),
      /secret connection material/u,
    );
    strict.throws(
      () =>
        defineDialectCapabilityStates(
          {
            returning: {
              level: "exact",
              reason: "Supported",
              evidence: [{ kind: "grammar", key: "version", value: "1" }],
            },
          },
          ["other"],
        ),
      /exactly match/u,
    );
    strict.throws(
      () =>
        resolveDialectCapabilityStates(
          {
            grammarVersion: "1.0.0",
            capabilities: { returning: false },
            resolveCapabilities: () => ({
              returning: {
                level: "exact",
                reason: "Supported",
                evidence: [{ kind: "grammar", key: "version", value: "1" }],
              },
            }),
          },
          {},
        ),
      /exceeds/u,
    );
  });

  await it("rejects malformed server evidence on every artifact boundary", () => {
    const valid = { product: "example", version: "1", versionKey: "1", features: [], settings: {} };
    for (const [value, pattern] of [
      [null, /must be an object/u],
      [{ ...valid, extra: true }, /unknown properties/u],
      [{ ...valid, product: "" }, /non-empty/u],
      [{ ...valid, version: `1${String.fromCharCode(0)}` }, /safe artifact text/u],
      [{ ...valid, versionKey: "x".repeat(201) }, /safe artifact text/u],
      [{ ...valid, features: ["alpha", "alpha"] }, /duplicates/u],
      [{ ...valid, features: [""] }, /non-empty strings/u],
      [{ ...valid, settings: [] }, /must be an object/u],
      [{ ...valid, settings: { "": true } }, /keys must be non-empty/u],
      [{ ...valid, settings: { mode: null } }, /string, boolean, or number/u],
      [{ ...valid, settings: { maximum: Number.POSITIVE_INFINITY } }, /must be finite/u],
    ] as const) {
      strict.throws(() => parseDialectServerEvidence(value), pattern);
    }
  });

  await it("rejects malformed capability state metadata", () => {
    const evidence = [{ kind: "grammar" as const, key: "version", value: "1" }];
    const define = (state: Record<string, unknown>, declared: readonly string[] = ["returning"]) =>
      defineDialectCapabilityStates({ returning: state } as never, declared);
    for (const [state, pattern] of [
      [null, /must be an object/u],
      [{ level: "exact", reason: "ok", evidence, extra: true }, /unknown properties/u],
      [{ level: "future", reason: "ok", evidence }, /exact, conservative, or unsupported/u],
      [{ level: "exact", reason: "", evidence }, /non-empty/u],
      [{ level: "exact", reason: "ok", since: "1", until: "1", evidence }, /same since and until/u],
      [{ level: "exact", reason: "ok", diagnostic: "bad", evidence }, /uppercase diagnostic/u],
      [{ level: "exact", reason: "ok", evidence: [] }, /at least one/u],
      [{ level: "exact", reason: "ok", evidence: [evidence[0], evidence[0]] }, /duplicates/u],
      [{ level: "exact", reason: "ok", evidence: [{ kind: "future", key: "x", value: "y" }] }, /evidence kind/u],
      [{ level: "exact", reason: "ok", evidence: [{ ...evidence[0], extra: true }] }, /unknown properties/u],
    ] as const) {
      strict.throws(() => define(state as never), pattern);
    }
    strict.throws(() => define({ level: "exact", reason: "ok", evidence }, ["Invalid-name"]), /lower camel/u);
    strict.throws(
      () => defineDialectCapabilityStates({ "Invalid-name": { level: "exact", reason: "ok", evidence } } as never),
      /lower camel/u,
    );
    strict.throws(() => staticDialectCapabilityStates({}, "1", undefined, "bad"), /uppercase diagnostic/u);
  });

  await it("applies unsupported capability diagnostics and unknown semantics", () => {
    const range = { start: 0, end: 10, line: 1, column: 1 } as const;
    const analysis = {
      columns: [],
      parameters: [],
      diagnostics: [],
      semantics: { ...unknownQuerySemantics(range, "test"), capabilities: ["returning"] },
    };
    const exact = defineDialectCapabilityStates({
      returning: { level: "exact", reason: "supported", evidence: [{ kind: "grammar", key: "version", value: "1" }] },
    });
    strict.strictEqual(applyDialectCapabilityStates(analysis, exact, range), analysis);
    const unsupported = defineDialectCapabilityStates({
      returning: {
        level: "unsupported",
        reason: "too old",
        evidence: [{ kind: "server-version", key: "example", value: "1" }],
      },
    });
    const result = applyDialectCapabilityStates(analysis, unsupported, range);
    strict.strictEqual(result.diagnostics[0]?.code, "TSQ401");
    strict.strictEqual(result.semantics.operation.value, "unknown");
  });
});
