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
  return { accepted: true };
}

export async function prepareMySql(client, sql) {
  try {
    const statement = await client.prepare(sql);
    await statement.close();
    return { accepted: true };
  } catch (error) {
    if (!error.errno || error.fatal || error.errno >= 2000 || [1044, 1045, 1142, 1227].includes(error.errno))
      throw error;
    return { accepted: false, reason: error.code ?? String(error.errno) };
  }
}

export async function describeSqlServer(client, sql) {
  try {
    const rows = await client.all(
      `SELECT error_number FROM sys.dm_exec_describe_first_result_set(N'${sql.replaceAll("'", "''")}',NULL,0)`,
    );
    return {
      accepted: rows.length > 0 && rows.every((row) => row.error_number == null),
      reason: rows.find((row) => row.error_number != null)?.error_number?.toString() ?? "metadata unavailable",
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
