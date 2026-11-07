import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SchemaSnapshot } from "@typed-sql/core";
import type { CatalogEvidence, MigrationHistory } from "@typed-sql/migrations";
import { postgres } from "@typed-sql/postgres";
import { describe, it, strict } from "poku";
import { buildExplorer, ExplorerService } from "../src/explorer.js";
import { explorerMigrationInventory } from "../src/migration-inventory.js";
import { historyNamespace, observePostgresMigrations, postgresCatalogObjects } from "../src/pg-explorer.js";
import { fixture, snapshot } from "./helpers/fixture.js";

const relation = 'relation:["public","accounts"]';
const oldColumn = 'column:["public","accounts","name"]';
const newColumn = 'column:["public","accounts","display_name"]';
const index = 'index:["public","accounts","pending_idx"]';
const type = 'type:["public","status"]';
const empty: CatalogEvidence = {
  formatVersion: 1,
  dialect: "postgres",
  serverMajor: "18",
  namespaces: ["public"],
  objects: {},
  coverage: "complete",
};
const detail = (kind: string, properties: Record<string, unknown>) =>
  JSON.parse(JSON.stringify({ formatVersion: 1, kind, properties }));
const before: CatalogEvidence = {
  ...empty,
  objects: {
    [relation]: { definitionHash: "a".repeat(64) },
    [oldColumn]: { definitionHash: "b".repeat(64) },
    [index]: { definitionHash: "c".repeat(64) },
    [type]: { definitionHash: "d".repeat(64) },
  },
  details: {
    [relation]: detail("relation", { kind: "table" }),
    [oldColumn]: detail("column", { type: "text", notNull: false }),
    [index]: detail("index", { method: "btree", keyColumns: ["name"] }),
    [type]: detail("type", { enum: ["open"] }),
  },
};
const after: CatalogEvidence = {
  ...before,
  objects: {
    [relation]: before.objects[relation]!,
    [newColumn]: { definitionHash: "e".repeat(64) },
    [type]: { definitionHash: "f".repeat(64) },
  },
  details: {
    [relation]: detail("relation", { kind: "table" }),
    [newColumn]: detail("column", { type: "text", notNull: true }),
    [type]: detail("type", { enum: ["open", "refunded"] }),
  },
};
const history: MigrationHistory = {
  formatVersion: 1,
  applied: [
    { id: "001", hash: "1".repeat(64), attemptId: "a", direction: "up", origin: "executed", catalog: before },
    { id: "002", hash: "2".repeat(64), attemptId: "b", direction: "up", origin: "executed", catalog: after },
  ],
  attempts: [
    {
      id: "a",
      migrationId: "001",
      hash: "1".repeat(64),
      direction: "up",
      state: "applied",
      beforeCatalog: empty,
      expectedCatalog: before,
    },
    {
      id: "b",
      migrationId: "002",
      hash: "2".repeat(64),
      direction: "up",
      state: "applied",
      beforeCatalog: before,
      expectedCatalog: after,
    },
  ],
};
const current = JSON.parse(JSON.stringify(snapshot)) as SchemaSnapshot;
const table = current.tables["public.accounts"]!;
const schema = {
  ...current,
  tables: {
    "public.accounts": {
      ...table,
      columns: {
        id: table.columns.id!,
        display_name: { name: "display_name", databaseType: "text", tsType: "string", nullable: false },
      },
    },
  },
};
const refs = postgresCatalogObjects([...new Set([...Object.keys(before.objects), ...Object.keys(after.objects)])]);
const report = (value = history) =>
  buildExplorer({
    schema,
    source: "live",
    capturedAt: "2026-01-01T00:00:00Z",
    local: [],
    state: "ready",
    observation: { state: "ready", database: "fixture", history: value, objects: refs },
  });
await describe("recorded schema explorer evidence", async () => {
  await it("shows exact enum/property changes, removed objects and descendant table/namespace history", () => {
    const result = report();
    const removed = result.schema.objects.find((object) => object.kind === "index")!;
    strict.equal((removed.details as { exists: boolean }).exists, false);
    strict.equal(removed.history.at(-1)?.change, "removed");
    strict.equal(removed.history.at(-1)?.evidence, "captured");
    const account = result.schema.objects.find((object) => object.kind === "table")!;
    strict.ok(account.history.some((event) => event.catalogKey === index && event.change === "removed"));
    strict.ok(account.history.some((event) => event.catalogKey === oldColumn && event.change === "removed"));
    strict.ok(account.history.some((event) => event.catalogKey === newColumn && event.change === "added"));
    const enumChange = result.migrations.entries
      .find((entry) => entry.id === "002")!
      .attempts[0]!.changes!.find((event) => event.catalogKey === type)!;
    strict.deepEqual(enumChange.before, before.details![type]);
    strict.deepEqual(enumChange.after, after.details![type]);
    strict.equal(enumChange.details, "captured");
    strict.ok(enumChange.objectId);
    strict.ok(
      result.schema.objects
        .find((object) => object.kind === "namespace")!
        .history.some((event) => event.catalogKey === type),
    );
  });
  await it("labels expected-only reverted after evidence instead of claiming actual capture", () => {
    const reverted: MigrationHistory = {
      formatVersion: 1,
      applied: [],
      attempts: [
        history.attempts[0]!,
        {
          id: "down",
          migrationId: "001",
          hash: "1".repeat(64),
          direction: "down",
          state: "applied",
          beforeCatalog: before,
          expectedCatalog: empty,
        },
      ],
    };
    const result = report(reverted);
    strict.equal(result.migrations.entries[0]!.status, "reverted");
    strict.ok(result.migrations.entries[0]!.attempts.every((event) => event.evidence === "expected"));
    strict.ok(
      result.migrations.entries[0]!.attempts.flatMap((event) => event.changes ?? []).every(
        (event) => event.evidence === "expected",
      ),
    );
  });
  await it("keeps missing/baseline/unknown evidence explicit and redacts unstructured catalog payloads", () => {
    const uncertain: MigrationHistory = {
      formatVersion: 1,
      applied: [],
      attempts: [
        {
          id: "u",
          migrationId: "003",
          hash: "3".repeat(64),
          direction: "up",
          state: "unknown",
          beforeCatalog: {
            ...before,
            details: undefined,
            objects: { [relation]: { secret: "default password literal" } },
          } as unknown as CatalogEvidence,
          expectedCatalog: after,
        },
      ],
    };
    const result = report(uncertain);
    strict.equal(result.migrations.entries[0]!.status, "unknown");
    strict.ok(result.schema.objects.every((object) => object.historyState === "unknown"));
    strict.ok(!JSON.stringify(result).includes("default password literal"));
    strict.ok(result.migrations.entries[0]!.attempts[0]!.changes!.every((event) => event.change === "unknown"));
  });
  await it("reads static TS ID metadata without executing modules, leaving dynamic IDs and hashes unverified", async () =>
    fixture(async (root) => {
      await mkdir(join(root, "migrations", "001"), { recursive: true });
      await writeFile(
        join(root, "migrations", "001", "migration.json"),
        JSON.stringify({ formatVersion: 1, id: "001", up: "up.sql" }),
      );
      await writeFile(join(root, "migrations", "001", "up.sql"), "create table accounts(id integer)");
      await writeFile(
        join(root, "migrations", "002.migration.ts"),
        'import {defineMigration as migration} from "@typed-sql/migrations"; process.env.TYPED_SQL_EXPLORER_MUST_NOT_EXECUTE="ran"; export default migration({id:"002",description:"Static metadata",up:[]}) satisfies object;',
      );
      await writeFile(
        join(root, "migrations", "dynamic.migration.ts"),
        'import {defineMigration} from "@typed-sql/migrations"; export default defineMigration({id:process.env.UNKNOWN_ID,up:[]});',
      );
      delete process.env.TYPED_SQL_EXPLORER_MUST_NOT_EXECUTE;
      const local = await explorerMigrationInventory(root, "migrations", postgres());
      strict.ok(local.find((entry) => entry.id === "001")?.hash);
      strict.equal(local.find((entry) => entry.id === "002")?.description, "Static metadata");
      strict.equal(local.find((entry) => entry.id === "002")?.hash, undefined);
      strict.ok(
        local.some((entry) => entry.id.startsWith("file:") && entry.files[0]?.endsWith("dynamic.migration.ts")),
      );
      strict.equal(process.env.TYPED_SQL_EXPLORER_MUST_NOT_EXECUTE, undefined);
      const linked = buildExplorer({
        schema,
        source: "saved",
        capturedAt: "now",
        state: "ready",
        local,
        observation: { state: "ready", database: "fixture", history, objects: refs },
      });
      strict.equal(linked.migrations.entries.find((entry) => entry.id === "002")!.status, "applied");
      strict.ok(linked.migrations.entries.find((entry) => entry.id === "002")!.files[0]?.endsWith("002.migration.ts"));
    }));
  await it("keeps PostgreSQL quoted catalog identifiers unambiguous and validates ledger namespace", () => {
    const key = 'column:["odd.namespace","table.with.dot","column:with:colon"]';
    const [ref] = postgresCatalogObjects([key]);
    strict.deepEqual(ref, {
      key,
      kind: "column",
      namespace: "odd.namespace",
      parentName: "table.with.dot",
      name: "column:with:colon",
    });
    strict.throws(() => historyNamespace(""));
    strict.throws(() => historyNamespace("x".repeat(64)));
    strict.equal(historyNamespace(undefined), "typed_sql");
  });
  await it("pins ledger reads to one read-only transaction and refuses oversized documents", async () => {
    for (const oversize of [false, true]) {
      const calls: string[] = [];
      let released: unknown;
      const pool = {
        connect: async () => ({
          query: async (text: string) => {
            calls.push(text);
            if (text.includes("current_database")) return { rows: [{ database: "fixture" }] };
            if (text.includes("to_regclass")) return { rows: [{ present: "typed_sql.migration_history" }] };
            if (text.includes("octet_length"))
              return { rows: [{ bytes: oversize ? 8 * 1024 * 1024 + 1 : 100, document: history }] };
            return { rows: [] };
          },
          release: (failure: unknown) => {
            released = failure;
          },
        }),
      } as unknown as import("pg").Pool;
      if (oversize) await strict.rejects(observePostgresMigrations(pool, "typed_sql"), /8 MiB/u);
      else {
        const observed = await observePostgresMigrations(pool, "typed_sql");
        strict.equal(observed.database, "fixture");
        strict.equal(observed.history.applied.length, 2);
      }
      strict.equal(calls[0], "begin isolation level repeatable read read only");
      strict.equal(calls.at(-1), "rollback");
      strict.equal(released, false);
      strict.ok(calls.every((text) => /^(?:select|begin|set local|rollback)/u.test(text)));
    }
  });
  await it("keeps cached history and GET state coherent while a newer refresh is pending", async () =>
    fixture(async (root) => {
      await mkdir(join(root, "migrations"));
      await writeFile(
        join(root, "migrations", "001.migration.ts"),
        'import {defineMigration} from "@typed-sql/migrations"; export default defineMigration({id:"001",up:[]});',
      );
      const service = new ExplorerService({
        root,
        directory: "migrations",
        renderer: postgres(),
        snapshot: () => ({ schema, source: "saved", capturedAt: "now" }),
      });
      const observation = { state: "ready" as const, database: "fixture", history, objects: refs };
      const target = (observe: () => Promise<typeof observation>) =>
        ({ migrationHistory: observe }) as unknown as import("../src/contracts.js").PlaygroundTarget;
      await service.refresh(
        target(async () => observation),
        "fixture",
      );
      let complete!: (value: typeof observation) => void;
      const pending = service.refresh(
        target(
          () =>
            new Promise((resolve) => {
              complete = resolve;
            }),
        ),
        "fixture",
      );
      const during = await service.get();
      strict.equal(during.migrations.state, "ready");
      strict.equal(during.migrations.entries.find((entry) => entry.id === "001")!.status, "applied");
      strict.equal(during.migrations.entries.find((entry) => entry.id === "001")!.attempts.length, 1);
      complete(observation);
      await pending;
      const afterRefresh = await service.get();
      strict.equal(afterRefresh.migrations.entries.find((entry) => entry.id === "001")!.status, "applied");
    }));
});
