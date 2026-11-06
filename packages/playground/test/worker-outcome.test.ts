import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "@typed-sql/config";
import { describe, it, strict } from "poku";
import { contentHash, WorkspaceFiles } from "../src/files.js";
import { RunManager } from "../src/runner.js";
import { fixture } from "./helpers/fixture.js";

async function terminal(manager: RunManager, id: string) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const record = manager.records.get(id)!;
    if (record.finishedAt) return record;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Worker outcome did not settle");
}

await describe("adapter outcome propagation through the actual worker", async () => {
  const cases = [
    { name: "confirmed failure", properties: "error.outcomeUnknown=false", status: "failed", code: "EXECUTION" },
    {
      name: "uncertain failure",
      properties: "error.outcomeUnknown=true",
      status: "outcome-unknown",
      code: "OUTCOME_UNKNOWN",
    },
    {
      name: "confirmed cancellation",
      properties: "error.code='TSQL_CANCELLED';error.confirmed=true",
      status: "cancelled",
      code: "CANCELLED",
    },
    {
      name: "unconfirmed cancellation",
      properties: "error.code='TSQL_CANCELLED';error.confirmed=false;error.outcomeUnknown=true",
      status: "outcome-unknown",
      code: "OUTCOME_UNKNOWN",
    },
  ];
  for (const scenario of cases) {
    await it(`preserves an adapter's ${scenario.name} before the host deadline`, async () =>
      fixture(async (directory) => {
        const configFile = join(directory, "typed-sql.config.mjs");
        const original = await readFile(configFile, "utf8");
        const query = "query:async request=>({columns:[{name:'id'}],rows:[[request.values[0]??42]],truncated:false})";
        strict.ok(original.includes(query));
        await writeFile(
          configFile,
          original.replace(
            query,
            `query:async()=>{const error=new Error('The connection ended during a write');error.name='PlaygroundPgError';${scenario.properties};throw error}`,
          ),
        );
        const source = "select id from public.accounts where id=$1";
        await writeFile(join(directory, "playground/query.sql"), source);
        const manager = new RunManager(
          await loadConfig({ file: configFile }),
          new WorkspaceFiles(directory, ["playground"], ["playground"]),
          { timeoutMs: 5000, maxRows: 5, maxResultBytes: 100_000, maxConsoleBytes: 100_000 },
          "local",
          join(directory, "tsconfig.json"),
        );
        try {
          const run = manager.start({
            requestId: `adapter-outcome-${scenario.name.replaceAll(" ", "-")}`,
            file: "playground/query.sql",
            revision: contentHash(source),
            mode: "sql",
            readOnly: false,
            values: [13],
          });
          const result = await terminal(manager, run.id);
          strict.equal(result.status, scenario.status, JSON.stringify(result));
          strict.equal(result.error?.code, scenario.code);
          strict.deepEqual(result.results, []);
        } finally {
          await manager.close();
        }
      }));
  }
});
