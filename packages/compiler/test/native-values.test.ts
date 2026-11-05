import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DIALECT_CONTRACT_VERSION,
  type DialectPlugin,
  type RuntimeValueType,
  type SchemaSnapshot,
  unknownQuerySemantics,
} from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { compileSource, compileSqlFile } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");
const physicalType = "STRUCT(id UBIGINT, pair STRUCT(tag VARCHAR, value BIGINT)[2])";
const native: RuntimeValueType = {
  object: {
    id: { type: "bigint", nullable: false },
    pair: {
      type: {
        array: {
          tuple: [
            { type: "string", nullable: false },
            { type: "bigint", nullable: true },
          ],
        },
        elementNullable: false,
        length: 2,
      },
      nullable: false,
    },
  },
};
const snapshot: SchemaSnapshot = { formatVersion: 1, dialect: "native-test", tables: {} };
// A public-contract fixture, independent of every built-in grammar implementation.
const dialect: DialectPlugin = {
  contractVersion: DIALECT_CONTRACT_VERSION,
  id: "native-test",
  grammarVersion: "1",
  sqlModule: "@typed-sql/core",
  runtimeSqlModule: "@typed-sql/core",
  capabilities: {},
  defaultTypePolicy: {},
  placeholder: (index) => `$${index}`,
  quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
  validateSnapshot: () => snapshot,
  parameterOccurrences(source) {
    return [...source.matchAll(/:([a-z]+)/gu)].map((match) => ({
      index: 0,
      name: match[1]!,
      range: { start: match.index!, end: match.index! + match[0].length, line: 1, column: match.index! + 1 },
    }));
  },
  analyze(source) {
    const range = { start: 0, end: source.length, line: 1, column: 1 };
    return {
      columns: [
        {
          name: "value",
          tsType:
            "{ readonly id: bigint; readonly pair: readonly [readonly [string, bigint | null], readonly [string, bigint | null]]; }",
          runtimeType: native,
          databaseType: physicalType,
          nullable: false,
          range,
        },
      ],
      parameters: [...source.matchAll(/\$(\d+)/gu)].map((match) => ({
        index: Number(match[1]),
        tsType:
          "{ readonly id: bigint; readonly pair: readonly [readonly [string, bigint | null], readonly [string, bigint | null]]; }",
        runtimeType: native,
        databaseType: physicalType,
        nullable: false,
      })),
      diagnostics: [],
      semantics: unknownQuerySemantics(range, "Synthetic contract test"),
    };
  },
};
await describe("native value metadata through public compiler contracts", async () => {
  await it("executes compiled inline factories with recursive validation and native targets", async () => {
    const compiled = compileSource({
      source: `import {sql,getQueryValuePlan,encodeQueryValues} from "@typed-sql/core";
const value={id:18446744073709551615n,pair:[["first",1n],["null",null]]};
const query=sql\`SELECT \${value} AS value\`;
const profile={id:"test",dialect:"native-test",integer:"lossless",jsonWire:"text"};
const plan=getQueryValuePlan(query);
if(encodeQueryValues(query,[value],profile)[0].id!==value.id)throw new Error("lost bigint");
let rejected=false;try{encodeQueryValues(query,[{...value,pair:[]}],profile)}catch{rejected=true}
if(!rejected)throw new Error("missing fixed-array validation");
process.stdout.write(JSON.stringify(plan));`,
      dialect,
      schema: snapshot,
      runtimeMetadata: true,
    });
    strict.deepEqual(compiled.diagnostics, []);
    const directory = await mkdtemp(resolve(root, "node_modules/.native-inline-"));
    try {
      const file = resolve(directory, "query.ts");
      await writeFile(file, compiled.transformedSource);
      const actual = JSON.parse(
        execFileSync(process.execPath, ["--import", "tsx", file], { cwd: root, encoding: "utf8" }),
      );
      strict.equal(actual.parameters[0].databaseType, physicalType);
      strict.equal(actual.columns[0].databaseType, physicalType);
      strict.deepEqual(actual.parameters[0].type, actual.columns[0].type);
      strict.equal(actual.parameters[0].type.object.pair.type.length, 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await it("preserves repeated named targets through generated SQL modules and executable factories", async () => {
    const result = compileSqlFile({
      source: "SELECT :payload AS value WHERE :payload IS NOT NULL",
      dialect,
      schema: snapshot,
    });
    strict.deepEqual(result.diagnostics, []);
    strict.ok(result.text.includes('parameters: { "payload":'));
    strict.ok(result.text.includes("readonly [string, bigint | null]"));
    const directory = await mkdtemp(resolve(root, "node_modules/.native-sql-file-"));
    try {
      await writeFile(resolve(directory, "query.mjs"), result.runtime);
      await writeFile(
        resolve(directory, "check.mjs"),
        `import factory,{valuePlan} from './query.mjs';
import {getQueryValuePlan,encodeQueryValues,renderQuery} from '@typed-sql/core';
const value={id:9007199254740993n,pair:[['a',null],['b',1n]]};const q=factory({payload:value});
const renderer={placeholder:i=>'$'+i,quoteIdentifier:x=>x};const rendered=renderQuery(q,renderer);
if(rendered.values.length!==2 || rendered.values[0]!==rendered.values[1])throw new Error('binding order lost');
encodeQueryValues(q,rendered.values,{id:'test',dialect:'native-test',integer:'lossless',jsonWire:'text'});
if(getQueryValuePlan(q)!==valuePlan)throw new Error('plan not retained');
console.log(JSON.stringify(valuePlan));`,
      );
      const actual = JSON.parse(
        execFileSync(process.execPath, [resolve(directory, "check.mjs")], { cwd: root, encoding: "utf8" }),
      );
      strict.deepEqual(
        actual.parameters.map((parameter: { databaseType: string }) => parameter.databaseType),
        [physicalType, physicalType],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
