import { defineConfig } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { it, strict } from "poku";
import { duckdb } from "../src/browser.js";
import { createNodeDuckDBLiveVerifier, createNodeDuckDBPlanInspector } from "../src/node-api.js";
import { defaultDuckDBTypePolicy } from "../src/type-policy.js";

await it("constructs strict offline CLI config without importing an application-owned SDK", async () => {
  let imports = 0;
  const sdkImporter = async () => {
    imports++;
    throw new Error("SDK must not load while reading offline config");
  };
  // This is the same public config contract consumed by CLI check, manifest and generation.
  const config = defineConfig({
    dialect: duckdb(),
    schema: { file: "schema.json" },
    outDir: "generated",
    verification: { live: createNodeDuckDBLiveVerifier({ sdkImporter }) },
    plans: { live: createNodeDuckDBPlanInspector({ sdkImporter }) },
  });
  const verifier = config.verification!.live!,
    inspector = config.plans!.live!;
  strict.equal(verifier.dialect, "duckdb");
  strict.equal(inspector.dialect, "duckdb");
  strict.equal(verifier.adapterVersion, duckdb().grammarVersion);
  strict.equal(inspector.parameterMode, "samples-required");
  strict.equal(verifier.typePolicyHash, calculateTypePolicyHash(defaultDuckDBTypePolicy));
  strict.equal(imports, 0);
  const closing = verifier.close();
  strict.equal(verifier.close(), closing);
  await Promise.all([closing, inspector.close(), inspector.close()]);
  strict.equal(imports, 0);
  await strict.rejects(verifier.server(), /closed/u);
  await strict.rejects(verifier.verify({ fingerprint: "unused", sql: "SELECT 1", operation: "read" }), /closed/u);
  await strict.rejects(inspector.environment(), /closed/u);
  await strict.rejects(
    inspector.capture({ fingerprint: "unused", sql: "SELECT 1", operation: "read", parameterCount: 0 }),
    /closed/u,
  );
  strict.equal(imports, 0);
});
await it("shares failed lazy initialization and never retries after close", async () => {
  let imports = 0;
  const failure = new Error("application SDK initialization failed");
  const verifier = createNodeDuckDBLiveVerifier({
    sdkImporter: async () => {
      imports++;
      throw failure;
    },
  });
  const outcomes = await Promise.allSettled([
    verifier.server(),
    verifier.verify({ fingerprint: "unused", sql: "SELECT 1", operation: "read" }),
  ]);
  strict.ok(outcomes.every((outcome) => outcome.status === "rejected" && outcome.reason === failure));
  strict.equal(imports, 1);
  await verifier.close();
  await strict.rejects(verifier.server(), /closed/u);
  strict.equal(imports, 1);
  const inspector = createNodeDuckDBPlanInspector({
    sdkImporter: async () => {
      imports++;
      throw failure;
    },
  });
  await strict.rejects(
    inspector.capture({
      fingerprint: "unused",
      sql: "SELECT 1",
      operation: "read",
      parameterCount: 1,
      values: [() => undefined],
    }),
    /cloneable/u,
  );
  strict.equal(imports, 1);
  await inspector.close();
});
await it("retires a queued first call before dispatching the SDK importer", async () => {
  let imports = 0;
  const verifier = createNodeDuckDBLiveVerifier({
    sdkImporter: async () => {
      imports++;
      throw new Error("must remain offline");
    },
  });
  const pending = verifier.server();
  await verifier.close();
  await strict.rejects(pending, /closed/u);
  strict.equal(imports, 0);
});
