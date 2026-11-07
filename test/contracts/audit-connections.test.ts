import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import type { AuditConnection, AuditConnectionOptions } from "../../scripts/language-audit/connections/contracts.js";
import { builtinAuditConnections } from "../../scripts/language-audit/connections/index.js";
import {
  collectAuditInventory,
  createAuditConnectionRegistry,
  openAuditConnection,
} from "../../scripts/language-audit/connections/registry.js";
import { createDiscoveryRegistry } from "../../scripts/language-audit/discovery/registry.mjs";

await describe("registered native audit connections", async () => {
  await it("provides an owner for every supported grammar without loading drivers to select one", async () => {
    const ledger = JSON.parse(await readFile(new URL("../../grammar/features/ledger.json", import.meta.url), "utf8"));
    strict.deepEqual([...builtinAuditConnections.ids].sort(), Object.keys(ledger.dialects).sort());
    strict.ok(Object.isFrozen(builtinAuditConnections));
    strict.ok(Object.isFrozen(builtinAuditConnections.ids));
    strict.throws(() => builtinAuditConnections.get("unregistered"), /Unregistered/u);
    strict.throws(() => createAuditConnectionRegistry([{ id: "missing" }]), /connect/u);
  });
  await it("inherits an engine connection for a graph contribution and discovers it through registered SQL", async () => {
    const received: AuditConnectionOptions[] = [];
    const completed: string[] = [];
    let closed = 0;
    const base = createAuditConnectionRegistry([
      {
        id: "vendor/base",
        completeInventory: async (capture) => {
          completed.push(capture.dialect);
        },
        connect: async (options) => {
          received.push(options);
          return {
            target: { version: "7.2" },
            async query(this: AuditConnection, sql: string) {
              strict.equal(this.target.version, "7.2");
              strict.equal(sql, "SELECT vendor_graph_inventory()");
              return [{ name: "graph_node", arguments: ["node_id"] }];
            },
            prepare: async () => ({ accepted: true }),
            close: () => {
              closed++;
            },
          };
        },
      },
    ]);
    const registry = base.extend([{ id: "vendor/graph", extends: "vendor/base" }]);
    strict.deepEqual(base.ids, ["vendor/base"]);
    strict.deepEqual(registry.ids, ["vendor/base", "vendor/graph"]);
    const connection = await openAuditConnection(registry, "vendor/graph", { version: "7.2", environment: {} });
    try {
      const discovery = createDiscoveryRegistry([
        {
          id: "vendor/graph",
          versionBand: (version: string) => version,
          normalizeRow: (_category: string, row: unknown) => row,
          routineFacts: () => ({ parameters: [] }),
          discoveryQueries: () => ({ functions: "SELECT vendor_graph_inventory()" }),
          discoveryRow: (_category: string, row: unknown) => row,
          discoveryScope: () => "extension-contribution",
          discoveryLimitation: () => "not exposed by this contribution",
          discoveryDerived: async () => {},
        },
      ]);
      const capture = await collectAuditInventory(registry, "vendor/graph", connection, discovery);
      strict.equal(capture.categories.functions?.rows?.[0]?.name, "graph_node");
      strict.deepEqual(received, [{ version: "7.2", environment: {} }]);
      strict.deepEqual(completed, ["vendor/graph"]);
      const invalid = registry.extend([
        {
          id: "vendor/invalid",
          extends: "vendor/graph",
          completeInventory: async (capture) => {
            capture.dialect = "vendor/base";
          },
        },
      ]);
      await strict.rejects(
        collectAuditInventory(
          invalid,
          "vendor/invalid",
          connection,
          discovery.extend([{ id: "vendor/invalid", extends: "vendor/graph" }]),
        ),
        /engine identity/u,
      );
    } finally {
      await connection.close();
    }
    strict.equal(closed, 1);
  });
  await it("requires an actual version and closes a connection that cannot qualify its identity", async () => {
    let closed = 0;
    const registry = createAuditConnectionRegistry([
      {
        id: "vendor",
        connect: async () => ({
          target: {},
          query: async () => [],
          prepare: async () => ({ accepted: true }),
          close: () => {
            closed++;
          },
        }),
      },
    ]);
    await strict.rejects(openAuditConnection(registry, "vendor"), /actual engine version/u);
    strict.equal(closed, 1);
    await strict.rejects(openAuditConnection(registry, "missing"), /Unregistered/u);
    strict.equal(closed, 1);
  });
  await it("collects SQLite compile options through its registered adapter before provenance", async () => {
    const connection = await openAuditConnection(builtinAuditConnections, "sqlite");
    try {
      const capture = await collectAuditInventory(builtinAuditConnections, "sqlite", connection);
      strict.equal(capture.categories.extensions?.status, "observed");
      strict.equal(capture.categories.extensions?.scope, "compile-options");
      strict.deepEqual(
        capture.categories.extensions?.rows,
        (await connection.query("PRAGMA compile_options")).map((row) => ({ name: row.compile_options })),
      );
      strict.ok((capture.categories.functions?.rows?.length ?? 0) > 0);
      strict.equal((await connection.prepare("SELECT abs(-1) AS value")).accepted, true);
      strict.equal((await connection.prepare("SELECT function_that_does_not_exist() AS value")).accepted, false);
      const rejected = await connection.prepare("SELECT abs(1,2) AS value");
      strict.equal(rejected.reason, "ERR_SQLITE_ERROR");
      strict.match(rejected.detail ?? "", /wrong number of arguments/u);
    } finally {
      await connection.close();
    }
  });
});
