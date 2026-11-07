import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { presentationSchema } from "../src/analysis-contract.js";
import { capturedCsv, filteredRows, hierarchyData, metricValue } from "../src/analysis-model.js";
import { AnalysisRoutes } from "../src/analysis-routes.js";
import { AnalysisStore } from "../src/analysis-store.js";
import { WorkspaceFiles } from "../src/files.js";
import { encodeValue } from "../src/values.js";

await describe("query-backed interactive analyses", async () => {
  const root = await mkdtemp(join(tmpdir(), "typed-sql-analysis-"));
  await mkdir(join(root, "playground"));
  const directory = join(root, "private"),
    store = new AnalysisStore(root, directory),
    conversation = randomUUID();
  const files = new WorkspaceFiles(root, ["playground"], ["playground"]);
  const result = {
    executed: true,
    schemaHash: "schema",
    identity: { database: "test", server: "local" },
    value: encodeValue({
      columns: [{ name: "region" }, { name: "team" }, { name: "active" }],
      rows: [
        ["EU", "A", 10n],
        ["EU", "B", 20n],
        ["US", "A", 30n],
      ],
      truncated: false,
    }),
  };
  let trusted = true,
    queries = 0;
  const routes = new AnalysisRoutes({
    store,
    files,
    trusted: () => trusted,
    schemaHash: () => "schema",
    target: "test",
    query: async (_source, values) => {
      queries++;
      strict.deepEqual(values, ["US"]);
      return result;
    },
  });
  const dataset = await store.capture(
    conversation,
    "select region, team, active from usage where region=$1",
    ["EU"],
    result,
    "test",
  );
  const input = {
    version: 1,
    title: "Active users",
    datasetId: dataset.id,
    views: [
      { id: "total", kind: "metric", title: "Active users", y: 2 },
      { id: "hierarchy", kind: "sunburst", title: "By region and team", hierarchy: [0, 1], y: 2 },
    ],
    filters: [{ id: "region", label: "Region", kind: "select", column: 0 }],
  };
  try {
    await it("retains exact captured values and validates all referenced columns and conversation scope", async () => {
      strict.deepEqual(dataset.rows[0]?.[2], { kind: "bigint", value: "10" });
      await strict.rejects(store.publish(randomUUID(), input), /conversation/u);
      await strict.rejects(
        store.publish(conversation, { ...input, views: [{ id: "bad", title: "Bad", kind: "bar", x: 0, y: 99 }] }),
        /Unknown column/u,
      );
      await strict.rejects(
        store.publish(conversation, { ...input, views: [{ id: "bad", title: "Bad", kind: "sunburst", y: 2 }] }),
        /hierarchy/u,
      );
      await strict.rejects(store.publish(conversation, { ...input, html: "<script/>" }));
    });
    const artifact = await store.publish(conversation, input);
    await it("renders metrics and leaf-level hierarchical totals from captured values", () => {
      strict.equal(metricValue(artifact.spec.views[0]!, dataset.rows), "60");
      strict.deepEqual(hierarchyData(artifact.spec.views[1]!, dataset.rows), [
        {
          name: "EU",
          value: 30,
          exact: "30",
          children: [
            { name: "A", value: 10, exact: "10" },
            { name: "B", value: 20, exact: "20" },
          ],
        },
        { name: "US", value: 30, exact: "30", children: [{ name: "A", value: 30, exact: "30" }] },
      ]);
      strict.equal(
        metricValue(artifact.spec.views[0]!, [["EU", "A", { kind: "bigint", value: "9007199254740993" }]]),
        "9007199254740993",
      );
      strict.throws(() => hierarchyData(artifact.spec.views[1]!, [["EU", "A", -1]]), /nonnegative/u);
      strict.throws(
        () => hierarchyData(artifact.spec.views[1]!, [["EU", "A", { kind: "bigint", value: "9007199254740993" }]]),
        /precision/u,
      );
    });
    await it("applies captured filters without opening a database and rejects stale updates", async () => {
      const update = await routes.handle(new URL("http://local/api/analyses/filters"), "POST", {
        id: artifact.id,
        revision: artifact.revision,
        values: { region: "EU" },
      });
      strict.equal(queries, 0);
      const capture = await store.get(artifact.id);
      strict.equal(filteredRows(dataset, capture.artifact.spec.filters, capture.artifact.filters).length, 2);
      strict.ok(update);
      await strict.rejects(store.update(artifact.id, artifact.revision, {}), /changed/u);
      await strict.rejects(store.update(artifact.id, capture.artifact.revision, { region: ["EU"] }), /controls/u);
    });
    await it("restores cards and filters from private storage with no query execution", async () => {
      const restored = await new AnalysisStore(root, directory).get(artifact.id);
      strict.deepEqual(restored.artifact.filters, { region: "EU" });
      strict.equal(restored.dataset.rows.length, 3);
      strict.equal(queries, 0);
    });
    await it("query controls bind an existing parameter and preserve managed query execution", async () => {
      const card = await store.publish(conversation, {
        ...input,
        filters: [{ id: "region", label: "Region", kind: "select", column: 0, mode: "query", parameter: 0 }],
      });
      await routes.handle(new URL("http://local/api/analyses/filters"), "POST", {
        id: card.id,
        revision: card.revision,
        values: { region: "US" },
      });
      strict.equal(queries, 1);
      strict.deepEqual((await store.get(card.id)).dataset.values, ["US"]);
      await strict.rejects(
        store.publish(conversation, {
          ...input,
          filters: [{ id: "bad", label: "Bad", kind: "select", column: 0, mode: "query", parameter: 9 }],
        }),
        /parameter/u,
      );
    });
    await it("saves reusable project definitions without captured rows or target credentials", async () => {
      await routes.handle(new URL("http://local/api/analyses/save"), "POST", {
        id: artifact.id,
        file: "playground/users.analysis.json",
      });
      const saved = JSON.parse(await readFile(join(root, "playground/users.analysis.json"), "utf8"));
      strict.equal(saved.spec.title, "Active users");
      strict.equal(saved.spec.datasetId, undefined);
      strict.equal(saved.rows, undefined);
      strict.equal(saved.identity, undefined);
      strict.equal(saved.query.sql, dataset.source);
      strict.ok((await files.list()).includes("playground/users.analysis.json"));
      await strict.rejects(
        routes.handle(new URL("http://local/api/analyses/save"), "POST", {
          id: artifact.id,
          file: "../users.analysis.json",
        }),
        /project-relative/u,
      );
      await strict.rejects(
        routes.handle(new URL("http://local/api/analyses/save"), "POST", {
          id: artifact.id,
          file: "playground/users.analysis.json",
        }),
        /exists|changed/u,
      );
    });
    await it("preserves partial-result evidence, exact decimal filtering and export safety", async () => {
      const partial = await store.capture(
        conversation,
        "select 1",
        [],
        {
          ...result,
          value: encodeValue({ columns: [{ name: "value" }], rows: [["0.10000000000000000001"]], truncated: true }),
        },
        "test",
      );
      strict.equal(partial.complete, false);
      const spec = presentationSchema.parse({
        version: 1,
        title: "Exact",
        datasetId: partial.id,
        views: [{ id: "v", title: "Value", kind: "metric", y: 0 }],
        filters: [{ id: "min", label: "Min", kind: "number", column: 0, operator: "gte" }],
      });
      strict.equal(filteredRows(partial, spec.filters, { min: "0.10000000000000000002" }).length, 0);
      strict.equal(capturedCsv(["name"], [["=SUM(1)"], ["hello, world"]]), '"name"\r\n"\'=SUM(1)"\r\n"hello, world"');
    });
    await it("rejects a changed target before any query and removes only unshared private captures", async () => {
      const card = await store.publish(conversation, {
        ...input,
        filters: [{ id: "region", label: "Region", kind: "select", column: 0, mode: "query", parameter: 0 }],
      });
      const other = new AnalysisRoutes({
        store,
        files,
        trusted: () => true,
        schemaHash: () => "schema",
        target: "other",
        query: async () => {
          throw Error("Query must not execute");
        },
      });
      await strict.rejects(
        other.handle(new URL("http://local/api/analyses/filters"), "POST", {
          id: card.id,
          revision: card.revision,
          values: { region: "US" },
        }),
        /Target/u,
      );
      await store.remove(card.id, card.revision);
      await strict.rejects(store.get(card.id), /unavailable/u);
      strict.equal(
        (await store.dataset(dataset.id, conversation)).id,
        dataset.id,
        "Other cards keep the shared source capture",
      );
      strict.ok((await files.list()).includes("playground/users.analysis.json"));
    });
    await it("revoked project trust prevents inspecting captures or executing actions", async () => {
      trusted = false;
      await strict.rejects(
        routes.handle(new URL(`http://local/api/analyses/capture?id=${artifact.id}`), "GET", undefined),
        /trust/u,
      );
      strict.equal(queries, 1);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
