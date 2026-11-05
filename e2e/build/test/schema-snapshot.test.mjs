import { describe, it, strict } from "poku";
import { consumer } from "../src/consumer.mjs";

await describe("packed portable snapshot validation", async () => {
  await it("runs strict shared codecs in a browser sandbox without Node globals or aliases", async () => {
    const fixture = await consumer(["esbuild"], ["@typed-sql/schema"]);
    try {
      const project = await fixture.project("portable-snapshot");
      const result = await fixture.node(
        project,
        `
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
const built=await build({bundle:true,write:false,platform:'browser',format:'iife',target:'es2024',
stdin:{resolveDir:process.cwd(),contents:\`
import {parseSchemaSnapshot,migrateSchemaSnapshot,SCHEMA_FORMAT_VERSION} from '@typed-sql/schema/snapshot';
const input={formatVersion:1,dialect:'synthetic',tables:{widgets:{name:'widgets',columns:{id:{name:'id',databaseType:'scalar',tsType:'number',nullable:false}}}}};
globalThis.result={parsed:parseSchemaSnapshot(input),migrated:migrateSchemaSnapshot(input),current:SCHEMA_FORMAT_VERSION};
try {parseSchemaSnapshot({...input,formatVersion:99});} catch {globalThis.rejected=true;}
\`}});
const context={TextEncoder,TextDecoder};
vm.runInNewContext(built.outputFiles[0].text,context,{timeout:5000});
const result=JSON.parse(JSON.stringify(context.result));
assert.equal(result.parsed.formatVersion,1);
assert.equal(result.parsed.tables.widgets.columns.id.tsType,'number');
assert.deepEqual(result.migrated,result.parsed);
assert.equal(result.current,2);
assert.equal(context.rejected,true);
console.log('Packed portable snapshot codecs run without Node services');
`,
      );
      strict.match(result.output, /Packed portable snapshot codecs run without Node services/u);
    } finally {
      await fixture.close();
    }
  });
});
