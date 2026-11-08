import { execFile as callback } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(callback);

async function omitPostgresAnalyzer(consumer: string): Promise<void> {
  const grammar = join(consumer, "node_modules", "@typed-sql", "postgres", "dist", "packages", "postgres", "src");
  for (const path of [
    "catalog",
    "index.js",
    "resolver.js",
    "semantics.js",
    "provider.js",
    "query.js",
    "type-policy.js",
    "runtime.js",
    "pg.js",
    "pg-contracts.js",
    "parser/parser.js",
  ])
    await rm(join(grammar, path), { recursive: true, force: true });
}

/** Mutates only this disposable packed installation, after its other consumer checks finish. */
export async function assertFrozenContractConsumer(consumer: string, env: NodeJS.ProcessEnv): Promise<void> {
  await omitPostgresAnalyzer(consumer);
  const file = join(consumer, "frozen-contract.mjs");
  await writeFile(
    file,
    `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, rm } from "node:fs/promises";
import { createContractDialect, createQueryContract, exportQueryContracts, loadQueryContracts, queryContractDigest } from "@typed-sql/analysis";
import { compileSource } from "@typed-sql/compiler";
import { calculateSchemaHash, calculateTypePolicyHash } from "@typed-sql/schema";
import { postgresProfile } from "@typed-sql/postgres/profile";
import { sql, defineQueryValuePlan, withQueryValuePlan } from "@typed-sql/postgres/tag";
import { decodeQueryResultRows } from "@typed-sql/core";
const require = createRequire(import.meta.url);
for (const name of ["pg", "mysql2", "mssql", "tedious"])
  assert.throws(() => require.resolve(name), { code: "MODULE_NOT_FOUND" });
await assert.rejects(import("@typed-sql/postgres"), { code: "ERR_MODULE_NOT_FOUND" });
const schema = { formatVersion: 1, dialect: "postgres", tables: {} };
const profile = postgresProfile();
const text = "SELECT vendor_score($1::bigint) AS score";
const context = {
  grammar: { id: "postgres", version: profile.grammarVersion },
  profileHash: queryContractDigest("packed-profile"), schemaHash: calculateSchemaHash(schema),
  databaseContextHash: queryContractDigest("packed-context"), typePolicyHash: calculateTypePolicyHash(profile.defaultTypePolicy),
  codecHash: queryContractDigest("packed-codec"), interpreterHash: queryContractDigest("packed-interpreter"),
};
// Synthetic native-shaped evidence tests the packed consumer. Real acquisition is a separate engine gate.
const field = { nativeType: { status: "known", value: { name: "bigint", complete: true } }, runtimeType: { status: "known", value: "bigint" }, nullable: { status: "unknown", reason: "not-described" }, descriptor: { oid: 20 } };
const valuePlan = defineQueryValuePlan({ dialect: "postgres", typePolicyHash: context.typePolicyHash,
  columns: [{ name: "score", type: "bigint", databaseType: "bigint", nullable: true }],
  parameters: [{ index: 1, type: "bigint", databaseType: "bigint", nullable: true }],
});
const nativeEvidence = { adapter: { id: "packed-test", version: "1" }, consistency: { mechanism: "guarded", scope: "synthetic-fixture" }, resultKind: "rows",
  columns: [{ ...field, name: "score" }], parameters: [{ ...field, index: 1 }],
  parameterOccurrences: profile.parameterOccurrences(text, schema).map(({ index, range }) => ({ index, start: range.start, end: range.end })),
};
const contract = createQueryContract({ sql: text, context, origin: "native-description", nativeEvidence, valuePlan });
await exportQueryContracts("./frozen-contracts", [contract]);
await rm("./.typed-sql", { recursive: true, force: true });
const dialect = createContractDialect({ profile, context, contracts: await loadQueryContracts("./frozen-contracts") });
const source = 'import {sql} from "@typed-sql/postgres"; const query=sql\`SELECT vendor_score(\${input}::bigint) AS score\`;';
const result = compileSource({ source, schema, dialect, runtimeMetadata: true });
assert.deepEqual(result.diagnostics, []);
assert.equal(result.queries.length, 1);
assert.match(result.queries[0].rowType, /score.*bigint.*null/u);
assert.match(result.queries[0].parameterType, /bigint.*null/u);
const query = withQueryValuePlan(sql\`SELECT vendor_score(\${7n}::bigint) AS score\`, result.queries[0].valuePlan);
assert.deepEqual(decodeQueryResultRows(query, [{ score: 8n }], { id: "packed-native", dialect: "postgres", integer: "lossless", jsonWire: "text", typePolicyHash: context.typePolicyHash }), [{ score: 8n }]);
const manifest = JSON.parse(await readFile("./frozen-contracts/manifest.json", "utf8"));
await rm("./frozen-contracts/queries/" + manifest.queries[0] + ".json");
await assert.rejects(loadQueryContracts("./frozen-contracts"), { code: "ENOENT" });
`,
  );
  await execFile(process.execPath, [file], { cwd: consumer, env });
}

/** Real native artifacts consumed in a fresh distribution-only process, without native/analyzer modules. */
export async function assertIsolatedPostgresContractConsumer(input: {
  contracts: string;
  context: unknown;
  schema: unknown;
  source: string;
  expected: string;
}): Promise<void> {
  const consumer = await mkdtemp(join(tmpdir(), "typed-sql-frozen-isolated-"));
  const workspace = fileURLToPath(new URL("../../", import.meta.url));
  try {
    await mkdir(join(consumer, "node_modules", "@typed-sql"), { recursive: true });
    for (const name of ["core", "schema", "analysis", "compiler", "ast", "postgres"]) {
      const destination = join(consumer, "node_modules", "@typed-sql", name);
      await mkdir(destination);
      await cp(join(workspace, "packages", name, "package.json"), join(destination, "package.json"));
      await cp(join(workspace, "packages", name, "dist"), join(destination, "dist"), { recursive: true });
    }
    await omitPostgresAnalyzer(consumer);
    await cp(input.contracts, join(consumer, "contracts"), { recursive: true });
    await writeFile(
      join(consumer, "inputs.json"),
      JSON.stringify({ context: input.context, schema: input.schema, source: input.source, expected: input.expected }),
    );
    await writeFile(
      join(consumer, "deny-network.mjs"),
      `
import net from "node:net";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
const denied = () => { throw new Error("Frozen contract consumer attempted network access"); };
net.Socket.prototype.connect = denied;
net.connect = denied; net.createConnection = denied;
dns.lookup = denied; dns.resolve = denied;
dns.promises.lookup = denied; dns.promises.resolve = denied;
globalThis.fetch = denied;
syncBuiltinESMExports();
`,
    );
    await writeFile(
      join(consumer, "consume.mjs"),
      `
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { compileSource } from "@typed-sql/compiler";
import { createContractDialect, loadQueryContracts } from "@typed-sql/analysis";
import { postgresProfile } from "@typed-sql/postgres/profile";
import { connect } from "node:net";
assert.throws(() => connect(9, "127.0.0.1"), /Frozen contract consumer attempted network access/u);
const require = createRequire(import.meta.url);
assert.throws(() => require.resolve("pg"), { code: "MODULE_NOT_FOUND" });
await assert.rejects(import("@typed-sql/postgres"), { code: "ERR_MODULE_NOT_FOUND" });
const input = JSON.parse(await readFile("./inputs.json", "utf8"));
const contracts = await loadQueryContracts("./contracts");
assert.equal(contracts[0].nativeEvidence.adapter.id, "@typed-sql/postgres/pg-contracts");
const result = compileSource({ source: input.source, schema: input.schema,
  dialect: createContractDialect({ profile: postgresProfile(), context: input.context, contracts }), runtimeMetadata: true });
assert.deepEqual(result.diagnostics, []);
assert.equal(result.transformedSource, input.expected);
const manifest = JSON.parse(await readFile("./contracts/manifest.json", "utf8"));
await rm("./contracts/queries/" + manifest.queries[0] + ".json");
await assert.rejects(loadQueryContracts("./contracts"), { code: "ENOENT" });
`,
    );
    const { NODE_PATH: _nodePath, ...env } = process.env;
    await execFile(process.execPath, ["--import", join(consumer, "deny-network.mjs"), join(consumer, "consume.mjs")], {
      cwd: consumer,
      env,
    });
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}
