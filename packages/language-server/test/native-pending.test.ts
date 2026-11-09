import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, strict } from "poku";
import { ProtocolClient } from "../../../test/helpers/protocol-client.js";
import { context, fixture } from "../../cli/test/helpers/contract-fixture.js";

async function configure(directory: string): Promise<void> {
  const path = join(directory, "typed-sql.config.mjs");
  const original = await readFile(path, "utf8");
  await writeFile(
    path,
    original
      .replace(
        'loadAnalyzer(){throw new Error("analyzer must remain cold")}',
        'loadAnalyzer:async()=>(await import("@typed-sql/postgres/analysis")).postgres()',
      )
      .replace(
        'analysis:{mode:"frozen",',
        `analysis:{mode:"live",cache:{connectionContext:"${"0".repeat(64)}",adapter:{id:"test/native",version:"1"}},live:{contextIntervalMs:1,
      async adapter(){
        const {readFile,writeFile,appendFile}=await import("node:fs/promises");
        const {setTimeout:delay}=await import("node:timers/promises");
        const context=${JSON.stringify(context)};
        const fact={nativeType:{status:"known",value:{name:"bigint",complete:true}},runtimeType:{status:"known",value:"bigint"},nullable:{status:"known",value:true,precision:"upper-bound"},descriptor:{}};
        return {connectionContext:"${"0".repeat(64)}",inspectContext:async signal=>{await appendFile(new URL("./observations",import.meta.url),"x");await delay(125,undefined,{signal});return context;},close:async()=>{},
          contribution:{id:"test/reconciliation",version:"1",grammar:context.grammar,classify:()=>({status:"resolved",rule:"test",reason:"Controlled test contribution"}),compare:()=>({status:"compatible",staticStatus:"known",rule:"test",reason:"Controlled test facts"})},
          adapter:{id:"test/native",version:"1",grammar:context.grammar,accept:()=>({accepted:true}),open:async()=>({context:async()=>context,close:async()=>{},
            async describe(candidate,signal){
              while(true){try{await readFile(new URL("./resume",import.meta.url));break;}catch(error){if(error.code!=="ENOENT")throw error;}await delay(10,undefined,{signal});}
              await writeFile(new URL("./acquired",import.meta.url),"described");
              return {adapter:{id:"test/native",version:"1"},consistency:{mechanism:"guarded",scope:"test"},resultKind:"rows",columns:[{name:candidate.sql.includes("AS updated")?"updated":"value",...fact}],parameters:candidate.parameterOccurrences.length?[{index:1,...fact}]:[],parameterOccurrences:candidate.parameterOccurrences};
            }})}};
      }
    },`,
      )
      .replace("owner:postgresContractReconciliationOwner", 'owner:{id:"test/reconciliation",version:"1"}'),
  );
}
await describe("native qualification progress over stdio", async () => {
  for (const languageId of ["typescript", "sql"])
    for (const pull of [false, true])
      await it(`shows pending ${languageId} diagnostics (${pull ? "pull" : "push"}) before acquisition and restores the completed program`, async () => {
        await fixture(async (directory) => {
          await configure(directory);
          let source =
            languageId === "sql"
              ? "SELECT :id::bigint AS value"
              : `${await readFile(join(directory, "src/query.ts"), "utf8")}\nconst unrelated: number = "wrong";`;
          const path = join(directory, languageId === "sql" ? "src/progress.sql" : "src/query.ts");
          await writeFile(path, source);
          const uri = pathToFileURL(path).href;
          const server = fileURLToPath(new URL("../dist/packages/language-server/src/server.js", import.meta.url));
          const client = new ProtocolClient(process.execPath, [server, "--stdio"], directory);
          try {
            await client.request("initialize", {
              processId: null,
              rootUri: pathToFileURL(directory).href,
              capabilities: pull ? { textDocument: { diagnostic: {} } } : {},
              initializationOptions: { nativePreview: false },
            });
            const notification = client.notification("textDocument/publishDiagnostics", (value: unknown) => {
              const report = value as { uri: string; diagnostics: { code: string }[] };
              return report.uri === uri && report.diagnostics.some((item) => item.code === "TSQ409");
            });
            client.notify("initialized", {});
            client.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text: source } });
            const firstPull = client.request("textDocument/diagnostic", { textDocument: { uri } });
            const pushed = (await notification) as {
              version: number;
              diagnostics: {
                code: string;
                severity: number;
                range: { start: { line: number; character: number }; end: { line: number; character: number } };
              }[];
            };
            strict.equal(pushed.version, 1);
            strict.equal(pushed.diagnostics[0]!.severity, 3);
            strict.equal(pushed.diagnostics[0]!.range.start.line, 0);
            strict.ok(pushed.diagnostics[0]!.range.start.character <= source.indexOf("SELECT"));
            strict.ok(pushed.diagnostics[0]!.range.end.character >= source.indexOf("SELECT") + 6);
            const pending = (await firstPull) as { items: { code: string }[] };
            strict.ok(pending.items.some((item) => item.code === "TSQ409"));
            await strict.rejects(lstat(join(directory, "acquired")), { code: "ENOENT" });
            if (languageId === "typescript" && pull) {
              const updated = client.notification("textDocument/publishDiagnostics", (value: unknown) => {
                const report = value as { uri: string; version: number; diagnostics: { code: string }[] };
                return (
                  report.uri === uri &&
                  report.version === 2 &&
                  report.diagnostics.some((item) => item.code === "TSQ409")
                );
              });
              source = source.replace("AS value", "AS updated");
              client.notify("textDocument/didChange", {
                textDocument: { uri, version: 2 },
                contentChanges: [{ text: source }],
              });
              await writeFile(join(directory, "resume"), "finish obsolete request");
              await updated;
            }
            const cleared = client.notification("textDocument/publishDiagnostics", (value: unknown) => {
              const report = value as { uri: string; diagnostics: { code: string }[] };
              return report.uri === uri && !report.diagnostics.some((item) => item.code === "TSQ409");
            });
            await writeFile(join(directory, "resume"), "continue");
            await cleared;
            const observations = await readFile(join(directory, "observations"), "utf8");
            const final = (await client.request("textDocument/diagnostic", { textDocument: { uri } })) as {
              items: { code: string | number; message: string }[];
            };
            strict.ok(!final.items.some((item) => item.code === "TSQ409"), JSON.stringify(final));
            strict.ok(!final.items.some((item) => String(item.code).startsWith("TSQ")), JSON.stringify(final));
            if (languageId === "typescript")
              strict.equal(
                await readFile(join(directory, "observations"), "utf8"),
                observations,
                "The completion pull must not begin another native refresh",
              );
            if (languageId === "typescript")
              strict.ok(
                final.items.some((item) => /string.*not assignable.*number/u.test(item.message)),
                JSON.stringify(final),
              );
            const hover = await client.request("textDocument/hover", {
              textDocument: { uri },
              position: { line: 0, character: source.indexOf("SELECT") },
            });
            strict.match(JSON.stringify(hover), /bigint/u);
            if (languageId === "typescript" && pull) strict.match(JSON.stringify(hover), /updated/u);
            strict.equal(await readFile(join(directory, "acquired"), "utf8"), "described");
          } finally {
            await writeFile(join(directory, "resume"), "cleanup");
            await client.close();
          }
        });
      });
});
