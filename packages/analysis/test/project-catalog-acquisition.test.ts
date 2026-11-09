import { describe, it, strict } from "poku";
import {
  acquireNativeProjectCatalog,
  createProjectCatalog,
  type NativeContractAdapter,
  type NativeContractSession,
  queryContractDigest,
} from "../src/index.js";

const hash = queryContractDigest("catalog-acquisition");
const context = {
  grammar: { id: "vendor/catalog", version: "1" },
  schemaHash: hash,
  typePolicyHash: hash,
  databaseContextHash: hash,
  profileHash: hash,
  codecHash: hash,
  interpreterHash: hash,
};
const owner = { id: "vendor/catalog-owner", version: "1" };
const catalog = () => createProjectCatalog({ context, owner, entries: [] });
function fixture(changes: Partial<NativeContractSession> = {}, adapterChanges: Partial<NativeContractAdapter> = {}) {
  const calls: string[] = [];
  let after = false;
  const session: NativeContractSession = {
    context: async () => {
      calls.push(after ? "after" : "before");
      after = true;
      return context;
    },
    describe: async () => {
      throw Error("Candidate preparation must not run");
    },
    projectCatalog: async (sql, selected) => {
      calls.push("catalog");
      strict.deepEqual(sql, ["SELECT vendor.lookup(1)"]);
      strict.deepEqual(selected, context);
      return catalog();
    },
    close: async () => {
      calls.push("close");
    },
    ...changes,
  };
  const adapter: NativeContractAdapter = {
    id: "vendor/native",
    version: "1",
    grammar: context.grammar,
    projectCatalogOwner: owner,
    accept: () => {
      throw Error("Query description admission must not run");
    },
    open: async () => {
      calls.push("open");
      return session;
    },
    ...adapterChanges,
  };
  return {
    calls,
    run: (input: { context?: typeof context; signal?: AbortSignal; sql?: readonly string[] } = {}) =>
      acquireNativeProjectCatalog({ adapter, sql: ["SELECT vendor.lookup(1)"], ...input }),
  };
}
await describe("guarded project metadata acquisition", async () => {
  await it("observes context without caller stitching and uses the contributed metadata path", async () => {
    const test = fixture();
    strict.deepEqual(await test.run(), { status: "acquired", catalog: catalog() });
    strict.deepEqual(test.calls, ["open", "before", "catalog", "after", "close"]);
    const pinned = fixture();
    strict.equal((await pinned.run({ context })).status, "acquired");
  });
  await it("keeps unsupported owners offline and closes unsupported advertised sessions", async () => {
    const test = fixture({}, { projectCatalogOwner: undefined } as unknown as Partial<NativeContractAdapter>);
    strict.deepEqual(await test.run(), { status: "unavailable", reason: "unsupported-adapter" });
    strict.deepEqual(test.calls, []);
    const missing = fixture({ projectCatalog: undefined } as unknown as Partial<NativeContractSession>);
    strict.deepEqual(await missing.run(), { status: "unavailable", reason: "unsupported-adapter" });
    strict.deepEqual(missing.calls, ["open", "close"]);
    await strict.rejects(
      fixture({}, { projectCatalogOwner: { ...owner, extra: true } as typeof owner }).run(),
      /owner/u,
    );
  });
  await it("rejects mismatched evidence, changed context and unbounded or executable selections", async () => {
    const pinned = fixture();
    strict.deepEqual(await pinned.run({ context: { ...context, databaseContextHash: queryContractDigest("other") } }), {
      status: "unavailable",
      reason: "context-mismatch",
    });
    strict.deepEqual(pinned.calls, ["open", "before", "close"]);
    let reads = 0;
    const drift = fixture({
      context: async () =>
        ++reads === 1 ? context : { ...context, databaseContextHash: queryContractDigest("drift") },
    });
    strict.deepEqual(await drift.run(), { status: "unavailable", reason: "context-changed" });
    strict.equal(drift.calls.at(-1), "close");
    for (const changed of [
      createProjectCatalog({ context, owner: { ...owner, version: "2" }, entries: [] }),
      createProjectCatalog({ context: { ...context, schemaHash: queryContractDigest("wrong") }, owner, entries: [] }),
    ]) {
      const test = fixture({ projectCatalog: async () => changed });
      await strict.rejects(test.run(), /evidence/u);
      strict.equal(test.calls.at(-1), "close");
    }
    await strict.rejects(
      fixture({ context: async () => ({ ...context, grammar: { id: "other", version: "1" } }) }).run(),
      /grammar/u,
    );
    await strict.rejects(
      fixture().run({ context: { ...context, grammar: { id: "other", version: "1" } } }),
      /grammar/u,
    );
    for (const sql of [[""], Array(4097).fill("SELECT 1"), [() => "SELECT 1"] as unknown as string[]])
      await strict.rejects(fixture().run({ sql }), TypeError);
  });
  await it("never publishes on cancellation or cleanup failure and preserves both failure causes", async () => {
    const controller = new AbortController();
    controller.abort(Error("cancelled"));
    const cancelled = fixture();
    await strict.rejects(cancelled.run({ signal: controller.signal }), /cancelled/u);
    strict.deepEqual(cancelled.calls, []);
    const during = new AbortController();
    const test = fixture({
      projectCatalog: async () => {
        during.abort(Error("cancelled during collection"));
        return catalog();
      },
    });
    await strict.rejects(test.run({ signal: during.signal }), /cancelled during/u);
    strict.equal(test.calls.at(-1), "close");
    await strict.rejects(
      fixture({
        close: async () => {
          throw Error("cleanup");
        },
      }).run(),
      /cleanup/u,
    );
    const both = fixture({
      projectCatalog: async () => {
        throw Error("capture");
      },
      close: async () => {
        throw Error("cleanup");
      },
    });
    await strict.rejects(
      both.run(),
      (error: unknown) =>
        error instanceof AggregateError && error.errors.length === 2 && error.errors[0].message === "capture",
    );
  });
});
