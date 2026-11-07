import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function preparePostgres(client, sql) {
  try {
    await client.query(`PREPARE typed_sql_language_audit AS ${sql}`);
  } catch (error) {
    if (!/^(42|0A|22)/u.test(error.code ?? "") || error.code === "42501") throw error;
    return { accepted: false, reason: error.code };
  }
  await client.query("DEALLOCATE typed_sql_language_audit");
  return {
    accepted: true,
    metadata: {
      status: "catalog-signature-preserved; result description unavailable through SQL PREPARE",
      parameterCount: 0,
      columns: null,
    },
  };
}

export async function prepareMySql(client, sql) {
  try {
    const statement = await client.prepare(sql);
    const columns = statement.statement?.columns;
    const metadata = Array.isArray(columns)
      ? {
          status: "native preparation metadata for this invocation",
          columns: columns.map((column) => ({
            name: column.name,
            engineType: column.columnType,
            flags: column.flags,
            characterSet: column.characterSet,
            columnLength: column.columnLength,
            decimals: column.decimals,
          })),
          parameterCount: statement.statement.parameters?.length ?? null,
        }
      : { status: "unavailable in this driver interface", columns: null };
    await statement.close();
    return { accepted: true, metadata };
  } catch (error) {
    if (
      !error.code?.startsWith("ER_") ||
      error.fatal ||
      /^(08|40)/u.test(error.sqlState ?? "") ||
      [1037, 1038, 1040, 1041, 1053, 1205, 1213, 1317].includes(error.errno)
    )
      throw error;
    return { accepted: false, reason: error.code ?? String(error.errno) };
  }
}

export async function describeSqlServer(client, sql) {
  try {
    const rows = await client.all(
      `SELECT error_number,column_ordinal,name,system_type_name,system_type_id,user_type_schema,user_type_name,is_nullable,max_length,precision,scale,collation_name FROM sys.dm_exec_describe_first_result_set(N'${sql.replaceAll("'", "''")}',NULL,0)`,
    );
    return {
      accepted: rows.length > 0 && rows.every((row) => row.error_number == null),
      reason: rows.find((row) => row.error_number != null)?.error_number?.toString() ?? "metadata unavailable",
      metadata: {
        status: "native result description for this invocation",
        columns: rows
          .filter((row) => row.error_number == null)
          .map((row) => ({
            ordinal: row.column_ordinal,
            name: row.name,
            nativeType: row.system_type_name,
            engineType: row.system_type_id,
            userTypeSchema: row.user_type_schema,
            userTypeName: row.user_type_name,
            nullable: row.is_nullable,
            maxLength: row.max_length,
            precision: row.precision,
            scale: row.scale,
            collation: row.collation_name,
          })),
        parameterCount: 0,
      },
    };
  } catch (error) {
    if (
      !error.diagnostics?.length ||
      error.diagnostics.some((row) => !/^42/u.test(row.state) || [229, 230].includes(row.native))
    )
      throw error;
    return { accepted: false, reason: error.diagnostics.map((row) => `${row.state}:${row.native}`).join(",") };
  }
}

export function recognitionSummary(recognition) {
  const { observations, ...metadata } = recognition;
  const counts = Object.fromEntries(
    [...new Set(observations.map((row) => row.status))]
      .sort()
      .map((status) => [status, observations.filter((row) => row.status === status).length]),
  );
  return { ...metadata, counts };
}

export async function enrichRecognition(input, prepare, server) {
  const { tsImport } = await import("tsx/esm/api");
  const { recognizeLive } = await tsImport("./recognition.ts", {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(new URL("tsconfig.json", import.meta.url)),
  });
  const functions = input.categories.functions;
  let rows = functions?.rows ?? [];
  if (!rows.length || functions.scope === "system-objects-only") {
    const version =
      input.dialect === "mysql"
        ? input.target.version.split(".").slice(0, 2).join(".")
        : input.target.version.split(".")[0];
    const reference = JSON.parse(
      await readFile(
        new URL(`../../test/fixtures/language-audit/${input.dialect}-${version}.json`, import.meta.url),
        "utf8",
      ),
    );
    rows = [...rows, ...reference.categories.functions.rows];
  }
  const recognition = await recognizeLive(input.dialect, input.target.version, rows, prepare, server);
  input.recognition = recognitionSummary(recognition);
  return recognition;
}
