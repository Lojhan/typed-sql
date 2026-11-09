import { DUCKDB_SUPPORT_POLICY } from "../../packages/duckdb/src/support-policy.ts";

// No SDK, compiler output or database is needed to enumerate the engines CI must verify.
const include = [
  ...DUCKDB_SUPPORT_POLICY.qualifiedEngines.map((version) => ({ dialect: "duckdb", version })),
  { dialect: "sqlite", version: `node-${process.versions.node}` },
];
process.stdout.write(`matrix=${JSON.stringify({ include })}\n`);
