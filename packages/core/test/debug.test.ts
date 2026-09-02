import { describe, it, strict } from "poku";
import { createDebugEvent, createSupportBundle, serializeSupportBundle } from "../src/index.js";

await describe("privacy-safe debug evidence", async () => {
  await it("redacts planted SQL, values, identifiers, paths, credentials, and arbitrary text by default", () => {
    const event = createDebugEvent({
      phase: "execute",
      event: "failure",
      failure: { code: "TSQL_TEST", classification: "driver" },
      context: {
        sql: "SELECT secret FROM customer WHERE password = $1",
        values: ["hunter2"],
        table: "customer",
        path: "/Users/alice/project/query.ts",
        token: "token-value",
        message: "server leaked customer@example.com",
        status: "failed",
      },
    });
    const serialized = JSON.stringify(event);
    for (const planted of ["SELECT secret", "hunter2", "customer", "/Users/alice", "token-value", "example.com"])
      strict.ok(!serialized.includes(planted));
    strict.ok(serialized.includes("TSQL_TEST"));
    strict.ok(Object.isFrozen(event));
  });

  await it("requires explicit opt-in for source, identifiers, paths, and free-form debug text", () => {
    const event = createDebugEvent(
      {
        phase: "analyze",
        event: "detail",
        context: { sql: "SELECT id", table: "account", path: "/project/query.ts", message: "debug detail" },
      },
      { includeSql: true, includeIdentifiers: true, includePaths: true, includeDebugText: true },
    );
    strict.deepStrictEqual(event.context, {
      message: "debug detail",
      path: "/project/query.ts",
      sql: "SELECT id",
      table: "account",
    });
  });

  await it("builds a previewable deterministic inventory and redacts again at the bundle boundary", () => {
    const bundle = createSupportBundle(
      [{ phase: "compile", event: "complete", durationMilliseconds: 4, context: { source: "SELECT private" } }],
      { version: "2.0.0", cwd: "/private/project" },
    );
    strict.deepStrictEqual(bundle.inventory, {
      eventCount: 1,
      phases: ["compile"],
      events: ["complete"],
      contextIncluded: true,
    });
    const serialized = serializeSupportBundle(bundle);
    strict.ok(!serialized.includes("SELECT private"));
    strict.ok(!serialized.includes("/private/project"));
    strict.deepStrictEqual(JSON.parse(serialized), bundle);
  });
});
