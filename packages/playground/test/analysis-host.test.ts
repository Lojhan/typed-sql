import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { context, fixture } from "../../cli/test/helpers/contract-fixture.js";
import type { RunRecord } from "../src/runner.js";
import { startPlayground } from "../src/server.js";

await describe("workspace contract host", async () => {
  for (const mode of ["offline", "frozen"] as const) {
    await it(`previews and runs recorded ${mode} queries without native/analyzer factories`, async () =>
      fixture(async (root) => {
        const config = join(root, "typed-sql.config.mjs");
        await writeFile(
          config,
          (await readFile(config, "utf8"))
            .replace('mode:"frozen"', `mode:"${mode}",live:{adapter(){throw Error("native must remain cold");}}`)
            .replace(
              'outDir:"generated"',
              'playground:{readRoots:["src"],writeRoots:["src"],targets:{local:{classification:"development",connect:()=>({identity:async()=>({database:"fixture",server:"fixture",readOnly:true,adapter:"test"}),query(){throw Error("No native query expected")},database(){return {}},close:async()=>{}})}}},outDir:"generated"',
            ),
        );
        const sql = "SELECT $1::bigint AS value";
        await writeFile(join(root, "src/query.sql"), sql);
        const application =
          'import {getQueryValuePlan} from "@typed-sql/core";' +
          'import {sql} from "@typed-sql/postgres";export function run(){const q=sql`SELECT ${1n}::bigint AS value`;return [{valid:getQueryValuePlan(q)?.columns[0]?.type==="bigint"}];}';
        await writeFile(join(root, "src/run.ts"), application);
        const host = await startPlayground({ config, target: "local" });
        const headers = { "content-type": "application/json", "x-typed-sql-session": host.token };
        const post = async (path: string, body: unknown) => {
          const response = await fetch(`${host.origin}/api/${path}`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          });
          const result = (await response.json()) as {
            diagnostics: { code: string }[];
            queries: { rowType: string }[];
            revision: string;
            id: string;
          };
          strict.ok(response.ok, JSON.stringify(result));
          return result;
        };
        try {
          const analysis = await post("analyze", { file: "src/query.sql", source: sql });
          strict.deepEqual(analysis.diagnostics, []);
          strict.match(analysis.queries[0]?.rowType ?? "", /bigint/u);
          if (mode === "frozen") {
            const missing = await post("analyze", { file: "src/query.sql", source: "SELECT $1::bigint AS changed" });
            strict.equal(missing.queries.length, 0);
            strict.ok(missing.diagnostics.some((d: { code: string }) => d.code === "TSQ406"));
          }
          const file = await post("file", { file: "src/query.sql" });
          await post("sql-types", { file: "src/query.sql", revision: file.revision });
          strict.match(await readFile(join(root, "src/query.d.sql.ts"), "utf8"), /bigint/u);
          await post("trust", { enable: true });
          const runFile = await post("file", { file: "src/run.ts" });
          const started = await post("run", {
            file: "src/run.ts",
            revision: runFile.revision,
            requestId: `contracts-${mode}-execution`,
            mode: "export",
            exportName: "run",
          });
          let run: RunRecord | undefined;
          for (let i = 0; i < 200; i++) {
            const state = (await fetch(`${host.origin}/api/state`, { headers }).then((r) => r.json())) as {
              runs: RunRecord[];
            };
            run = state.runs.find((r) => r.id === started.id);
            if (run?.finishedAt) break;
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          strict.equal(run?.status, "succeeded", JSON.stringify(run));
          strict.match(JSON.stringify(run?.results), /true/u);
        } finally {
          await host.close();
        }
      }));
  }
});

await it("starts native qualification only after trust and closes its owned services on revocation", async () =>
  fixture(async (root) => {
    const config = join(root, "typed-sql.config.mjs");
    const opened = join(root, "native-opened");
    const closed = join(root, "native-closed");
    await writeFile(join(root, "native-context.json"), JSON.stringify(context));
    let source = await readFile(config, "utf8");
    source =
      `import {readFile,writeFile} from "node:fs/promises";import {createPostgresContractReconciler} from "@typed-sql/postgres/reconciliation";\n` +
      source;
    source = source.replace(
      'loadAnalyzer(){throw new Error("analyzer must remain cold")}',
      'async loadAnalyzer(){return (await import("@typed-sql/postgres/analysis")).postgres();}',
    );
    source = source.replace(
      'analysis:{mode:"frozen",',
      `playground:{readRoots:["src"],writeRoots:["src"]},analysis:{mode:"live",cache:{connectionContext:"${"a".repeat(64)}",adapter:{id:"fixture/native",version:"1"}},live:{async adapter({schema}){
    await writeFile(new URL("./native-opened",import.meta.url),"opened");
    const context=JSON.parse(await readFile(new URL("./native-context.json",import.meta.url),"utf8"));
    const adapter={id:"fixture/native",version:"1",grammar:context.grammar,accept:()=>({accepted:true}),async open(){return {context:async()=>context,close:async()=>{},describe:async(candidate)=>({adapter:{id:"fixture/native",version:"1"},consistency:{mechanism:"snapshot",scope:"fixture"},resultKind:"rows",parameterOccurrences:candidate.parameterOccurrences,columns:[{name:"value",nativeType:{status:"known",value:{name:"bigint",complete:true}},runtimeType:{status:"known",value:"bigint"},nullable:{status:"known",value:true,precision:"upper-bound"},descriptor:{}}],parameters:[{index:1,nativeType:{status:"known",value:{name:"bigint",complete:true}},runtimeType:{status:"known",value:"bigint"},nullable:{status:"known",value:true,precision:"upper-bound"},descriptor:{}}]})}}};
    return {adapter,connectionContext:"${"a".repeat(64)}",contribution:createPostgresContractReconciler({schema}),inspectContext:async()=>context,close:()=>writeFile(new URL("./native-closed",import.meta.url),"closed")};
  }},`,
    );
    await writeFile(config, source);
    await writeFile(join(root, "src/query.sql"), "SELECT $1::bigint AS value");
    const host = await startPlayground({ config });
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${host.origin}/api/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-typed-sql-session": host.token },
        body: JSON.stringify(body),
      });
      const value = await response.json();
      strict.ok(response.ok, JSON.stringify(value));
      return value;
    };
    try {
      await post("analyze", { file: "src/query.sql", source: "SELECT $1::bigint AS value" });
      await strict.rejects(readFile(opened), /ENOENT/u);
      await post("trust", { enable: true });
      await post("analyze", { file: "src/query.sql", source: "SELECT $1::bigint AS value" });
      strict.equal(await readFile(opened, "utf8"), "opened");
      await post("trust", { enable: false });
      strict.equal(await readFile(closed, "utf8"), "closed");
    } finally {
      await host.close();
    }
  }));
