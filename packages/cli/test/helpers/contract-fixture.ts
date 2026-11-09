import { execFile as callback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createQueryContract, exportQueryContracts, queryContractDigest } from "../../../analysis/src/index.js";
import { postgresContractIdentity } from "../../../postgres/src/contract-profile.js";
import { postgresProfile } from "../../../postgres/src/profile.js";
import { calculateSchemaHash, calculateTypePolicyHash } from "../../../schema/src/index.js";

const executeFile = promisify(callback),
  workspace = fileURLToPath(new URL("../../../../", import.meta.url));
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
  tsx = fileURLToPath(import.meta.resolve("tsx"));
const profile = postgresProfile(),
  schema = { formatVersion: 1, dialect: "postgres", tables: {} } as const;
export const context = {
  grammar: { id: "postgres", version: profile.grammarVersion },
  ...postgresContractIdentity(),
  schemaHash: calculateSchemaHash(schema),
  typePolicyHash: calculateTypePolicyHash(profile.defaultTypePolicy),
  databaseContextHash: queryContractDigest("recorded-test-database"),
};

export async function fixture(test: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(workspace, ".typed-sql-frozen-check-"));
  try {
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "schema.json"), JSON.stringify(schema));
    await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ESNext",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          allowArbitraryExtensions: true,
        },
        include: ["src/**/*.ts"],
      }),
    );
    await writeFile(
      join(directory, "src/query.ts"),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Application fixture; interpolation must remain literal source.
      'import {sql} from "@typed-sql/postgres/tag"; export function query(value:bigint){return sql`SELECT ${value}::bigint AS value`;}',
    );
    const config = `import {defineConfig} from "@typed-sql/core"; import {postgresProfile} from "@typed-sql/postgres/profile";
      import {postgresContractIdentity,postgresContractReconciliationOwner} from "@typed-sql/postgres/contract-profile";
      export default defineConfig({dialect:{...postgresProfile(),loadAnalyzer(){throw new Error("analyzer must remain cold")}},schema:{file:"schema.json",provider:{introspect(){throw new Error("provider must remain cold")}}},outDir:"generated",projects:["tsconfig.json"],analysis:{mode:"frozen",context:${JSON.stringify(context)},identity:postgresContractIdentity(),qualification:{mode:"hybrid",owner:postgresContractReconciliationOwner,requiredNativeFacets:[]}}});`;
    await writeFile(join(directory, "typed-sql.config.mjs"), config);
    const contract = createQueryContract({
      sql: "SELECT $1::bigint AS value",
      context,
      origin: "offline-rule",
      valuePlan: {
        dialect: "postgres",
        typePolicyHash: context.typePolicyHash,
        columns: [{ name: "value", type: "bigint", databaseType: "bigint", nullable: true }],
        parameters: [{ index: 1, type: "bigint", databaseType: "bigint", nullable: true }],
      },
    });
    await exportQueryContracts(join(directory, "generated/contracts"), [contract]);
    await test(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export const execute = (directory: string, args: string[] = [], command = "check") =>
  executeFile(process.execPath, ["--import", tsx, cli, command, ...args], {
    cwd: directory,
    maxBuffer: 8 * 1024 * 1024,
  });
