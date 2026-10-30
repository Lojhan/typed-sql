import { strict as assert, describe, it } from "poku";
import { consumer, writeEntry } from "../src/consumer.mjs";

const fixture = await consumer(["vite", "vite-legacy", "esbuild", "rollup"]);
try {
  await describe("Real host dependency invalidation", async () => {
    for (const host of ["vite", "vite-legacy"]) {
      await it(`${host} refreshes schema and imported config in its live SSR graph`, async () => {
        const root = await fixture.project(host);
        await writeEntry(root);
        const result = await fixture.node(
          root,
          `import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {createServer} from ${JSON.stringify(host)};
import {typedSql} from "@typed-sql/build/vite";
import {getQueryValuePlan} from "@typed-sql/core";
const server=await createServer({root:process.cwd(),configFile:false,plugins:[typedSql()],server:{middlewareMode:true}});
const waitFor=async(expected)=>{const deadline=Date.now()+15000;let last;while(Date.now()<deadline){try{const value=await server.ssrLoadModule("/entry.ts");if(await expected(value))return value;}catch(error){last=error;}await new Promise(resolve=>setTimeout(resolve,50));}throw last??new Error("Host watcher did not refresh compiler inputs");};
const email=query=>getQueryValuePlan(query).columns.find(column=>column.name==="email");
try {
 const initial=await waitFor(value=>email(value.query(1)).nullable===false);
 const hash=getQueryValuePlan(initial.query(1)).typePolicyHash;
 const schema=JSON.parse(await readFile("schema.json","utf8"));schema.tables.account.columns.email.nullable=true;await writeFile("schema.json",JSON.stringify(schema));
 await waitFor(value=>email(value.query(1)).nullable===true && email(value.inline(1)).nullable===true);
 await writeFile("policy.mjs",'export const integer="bigint";');
 await waitFor(value=>getQueryValuePlan(value.query(1)).typePolicyHash!==hash && getQueryValuePlan(value.inline(1)).typePolicyHash!==hash);
 console.log("watch inputs refreshed");
}finally{await server.close();}`,
        );
        assert.match(result.output, /watch inputs refreshed/u);
      });
    }
    await it("Rollup watch rebuilds SQL loads and cached inline modules after a snapshot change", async () => {
      const root = await fixture.project("rollup-watch");
      await writeEntry(root);
      const result = await fixture.node(
        root,
        `import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {watch} from "rollup";
import {typedSql} from "@typed-sql/build/rollup";
import {getQueryValuePlan} from "@typed-sql/core";
const watcher=watch({input:"entry.ts",external:id=>id.startsWith("@typed-sql/"),plugins:[typedSql()],output:{file:"dist/output.mjs",format:"esm"},watch:{clearScreen:false}});
let generation=0;let failure;watcher.on("event",event=>{if(event.code==="ERROR")failure=event.error;if(event.code==="END")generation++;if(event.code==="BUNDLE_END")void event.result.close();});
async function built(previous){const deadline=Date.now()+15000;while(generation<=previous){if(failure)throw failure;if(Date.now()>deadline)throw new Error("Rollup did not rebuild");await new Promise(resolve=>setTimeout(resolve,50));}return import("./dist/output.mjs?generation="+generation);}
try{
 const first=await built(0);assert.equal(getQueryValuePlan(first.query(1)).columns[1].nullable,false);
 let previous=generation;const schema=JSON.parse(await readFile("schema.json","utf8"));schema.tables.account.columns.email.nullable=true;await writeFile("schema.json",JSON.stringify(schema));
 const second=await built(previous);assert.equal(getQueryValuePlan(second.query(1)).columns[1].nullable,true);assert.equal(getQueryValuePlan(second.inline(1)).columns[1].nullable,true);
 console.log("watch inputs refreshed");
}finally{await watcher.close();}`,
      );
      assert.match(result.output, /watch inputs refreshed/u);
    });
  });
} finally {
  await fixture.close();
}
