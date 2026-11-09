import { DUCKDB_SUPPORT_POLICY } from "../src/support-policy.ts";
import { writeOfflineCatalogs } from "./write-offline-catalogs.mjs";

for (const version of DUCKDB_SUPPORT_POLICY.qualifiedEngines) {
  const { signatures, implicitCasts } = await import(`../src/catalog/${version}.ts`);
  await writeOfflineCatalogs(version, signatures, implicitCasts, process.argv.includes("--check"));
}
