import { decodeFunctions, rowsLiteral } from "./common.mjs";
import { sqlServerTypeSource } from "./sqlserver-types.mjs";

export async function generateCatalog({ groups, input, emit, header }) {
  const policy = await input("policy", "grammar/sqlserver/catalog/policy.json");
  if (policy.formatVersion !== 1) throw new Error("Unsupported sqlserver generation policy");
  const entries = decodeFunctions(policy.functions, {
    bounds: (row) => [row.minimumArguments, row.maximumArguments],
    withBounds: (row, bounds) => ({ ...row, maximumArguments: bounds[1] }),
  });
  for (const entry of entries) {
    if (
      entry.resultType !== undefined &&
      !policy.types.some((type) => type.name === entry.resultType && type.form === "plain")
    )
      throw new Error(`Missing plain SQL Server result type policy: ${entry.name}`);
    if (entry.intrinsicNullable !== undefined && typeof entry.intrinsicNullable !== "boolean")
      throw new Error(`Invalid intrinsic nullability policy: ${entry.name}`);
  }
  await emit("packages/sqlserver/src/catalog/generated/types.ts", sqlServerTypeSource(policy, groups, header));
  await emit(
    "packages/sqlserver/src/catalog/generated/policy.ts",
    `${header}import type { SqlServerBuiltin } from "../index.js";\nexport const builtinEntries: readonly SqlServerBuiltin[] = Object.freeze(${rowsLiteral(entries)});\nexport const dateparts = ${rowsLiteral(policy.dateparts)} as const;\n`,
  );
}
