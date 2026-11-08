import { strict } from "poku";
import type { LiveQueryVerifier } from "../../packages/core/src/index.js";
import type {
  NativeDescription,
  NativePrepare,
  NativeTypeDescriptor,
} from "../../scripts/language-audit/native-description/contracts.js";

/** Preparation-only protocol qualification. No application values or execution method are supplied. */
export async function assertMySqlContractProtocol(prepare: NativePrepare): Promise<void> {
  const describe = async (sql: string, count: number): Promise<NativeDescription> => {
    const result = await prepare(sql);
    strict.equal(result.accepted, true, sql);
    const metadata = result.metadata as NativeDescription;
    strict.equal(metadata.parameterCount, count, sql);
    strict.equal(metadata.columns?.length, 1, sql);
    strict.equal(metadata.parameters?.length ?? 0, count, sql);
    for (const [index, field] of (metadata.parameters ?? []).entries()) strict.equal(field.index, index + 1);
    for (const field of [...metadata.columns!, ...(metadata.parameters ?? [])])
      for (const key of ["engineType", "flags", "characterSet", "columnLength", "decimals"] as const)
        strict.ok(Number.isSafeInteger(field[key]), `Missing ${key}: ${sql}`);
    return metadata;
  };
  const identity = (field: NativeTypeDescriptor) => [field.engineType, field.columnLength, field.decimals];
  const signed = await describe("SELECT CAST(? AS SIGNED) AS value", 1);
  strict.equal(signed.parameters![0]!.engineType, 8);
  strict.equal(signed.columns![0]!.engineType, 8);
  const decimal = await describe("SELECT CAST(? AS DECIMAL(12,3)) AS value", 1);
  strict.equal(decimal.parameters![0]!.engineType, 246);
  strict.equal(decimal.columns![0]!.engineType, 246);
  strict.equal(decimal.columns![0]!.decimals, 3);
  strict.notDeepEqual(
    identity(decimal.parameters![0]!),
    identity(decimal.columns![0]!),
    "Native parameter metadata is independently derived; a cast's result dimensions cannot stand in for its input",
  );
  await describe("SELECT CONCAT(?, ?) AS value", 2);
  const unsigned = await describe("SELECT CAST(1 AS UNSIGNED) AS value", 0);
  strict.equal(unsigned.columns![0]!.flags! & 32, 32, "Retain unsigned native identity");
  for (const functionName of ["ATAN", "ATAN2"])
    for (const argumentsSql of ["1", "1,2"])
      strict.equal((await describe(`SELECT ${functionName}(${argumentsSql}) AS value`, 0)).columns![0]!.engineType, 5);
}

/** The packaged verifier must retain the same independently described protocol distinctions. */
export async function assertMySqlVerificationMetadata(verifier: LiveQueryVerifier): Promise<void> {
  const result = await verifier.verify({
    fingerprint: `sha256:${"a".repeat(64)}`,
    sql: "SELECT CAST(? AS DECIMAL(12,3)) AS amount, CAST(1 AS UNSIGNED) AS id, CONCAT(?, ?) AS text_value",
    operation: "read",
  });
  strict.deepEqual(
    result.columns.map(({ databaseType, tsType }) => [databaseType, tsType]),
    [
      ["decimal(12,3)", "string"],
      ["bigint unsigned", "bigint"],
      ["mediumtext", "string"],
    ],
  );
  strict.deepEqual(
    result.parameters.map(({ databaseType, tsType }) => [databaseType, tsType]),
    [
      ["decimal(65,30)", "string"],
      ["varchar", "string"],
      ["varchar", "string"],
    ],
  );
}
