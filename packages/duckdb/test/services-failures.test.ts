import { it, strict } from "poku";
import { createDuckDBLiveVerifier, createDuckDBPlanInspector, type DuckDBServiceSession } from "../src/services.js";
import { defaultDuckDBTypePolicy } from "../src/type-policy.js";
import { duckDBServerEvidence } from "../src/support.js";
const fingerprint = `sha256:${"a".repeat(64)}`;
await it("rejects malformed native plan evidence without leaking native content", async () => {
  let response: readonly (readonly unknown[])[] = [],
    parameters = true;
  const session: DuckDBServiceSession = {
    async server() {
      return duckDBServerEvidence("2.0.0");
    },
    async describe(_sql, work) {
      return work({
        ...(parameters ? { parameters: [] } : {}),
        async execute() {
          throw new Error("Native execute must not run while verifying");
        },
        close() {},
      });
    },
    async rows() {
      return response;
    },
  };
  const transport = {
    async lease<T>(work: (session: DuckDBServiceSession) => Promise<T>) {
      return work(session);
    },
  };
  const verifier = createDuckDBLiveVerifier(transport, defaultDuckDBTypePolicy, "policy-hash"),
    inspector = createDuckDBPlanInspector(transport, defaultDuckDBTypePolicy);
  strict.deepEqual(await verifier.server(), { version: "2.0.0", features: [] });
  strict.deepEqual(await verifier.verify({ fingerprint, sql: "SELECT 1 AS value", operation: "read" }), {
    columns: [],
    parameters: [],
    unavailable: ["columns"],
  });
  parameters = false;
  strict.deepEqual((await verifier.verify({ fingerprint, sql: "SELECT 1 AS value", operation: "read" })).unavailable, [
    "columns",
    "parameters",
  ]);
  await strict.rejects(
    inspector.capture({ fingerprint, sql: "SELECT 1", operation: "read", parameterCount: 0 }),
    /capture failed/u,
  );
  parameters = true;
  for (const payload of [
    null,
    "{}",
    "not json",
    "x".repeat(4 * 1024 * 1024 + 1),
    JSON.stringify([null]),
    JSON.stringify([{ name: 1, children: [] }]),
    JSON.stringify([{ name: "SCAN", children: null }]),
    JSON.stringify([{ name: "x".repeat(1025), children: [] }]),
  ]) {
    response = [["physical_plan", payload]];
    await strict.rejects(
      inspector.capture({ fingerprint, sql: "SELECT 1", operation: "read", parameterCount: 0 }),
      /capture failed/u,
    );
  }
  response = [["wrong", "[]"]];
  await strict.rejects(
    inspector.capture({ fingerprint, sql: "SELECT 1", operation: "read", parameterCount: 0 }),
    /capture failed/u,
  );
  response = [
    [
      "physical_plan",
      JSON.stringify([
        {
          name: " ROOT ",
          children: [
            {
              name: "CHILD",
              children: [],
              extra_info: { Table: "catalog.schema.table", "Estimated Cardinality": 42, Filter: "SECRET" },
            },
          ],
          extra_info: { "Estimated Cardinality": "unknown", Table: 42 },
        },
      ]),
    ],
  ];
  strict.deepEqual(await inspector.capture({ fingerprint, sql: "SELECT 1", operation: "read", parameterCount: 0 }), {
    nodes: [{ kind: "ROOT" }, { kind: "CHILD", relation: "catalog.schema.table", estimatedRows: 42 }],
  });
  response = [
    [
      "physical_plan",
      JSON.stringify([
        { name: "EMPTY", children: [], extra_info: { "Estimated Cardinality": -1, Table: "x".repeat(4097) } },
      ]),
    ],
  ];
  strict.deepEqual(
    (await inspector.capture({ fingerprint, sql: "SELECT 1", operation: "read", parameterCount: 0 })).nodes,
    [{ kind: "EMPTY" }],
  );
  let nested: unknown = { name: "LEAF", children: [] };
  for (let depth = 0; depth < 130; depth++) nested = { name: "NODE", children: [nested] };
  response = [["physical_plan", JSON.stringify([nested])]];
  await strict.rejects(
    inspector.capture({ fingerprint, sql: "SELECT 1", operation: "read", parameterCount: 0 }),
    /capture failed/u,
  );
  response = [["physical_plan", JSON.stringify(Array.from({ length: 16385 }, () => ({ name: "NODE", children: [] })))]];
  await strict.rejects(
    inspector.capture({ fingerprint, sql: "SELECT 1", operation: "read", parameterCount: 0 }),
    /capture failed/u,
  );
  response = [[42, "bad"]];
  await strict.rejects(inspector.environment(), /environment failed/u);
});
