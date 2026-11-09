import type { Connection, RowDataPacket } from "mysql2/promise";
import { strict } from "poku";
import type { MySqlVocabulary } from "../../packages/mysql/src/vocabulary/types.js";

/** Independent native metadata and COM_STMT_PREPARE oracle. Candidates are never executed. */
export async function assertMySqlVocabulary(connection: Connection): Promise<void> {
  const [identity] = await connection.query<RowDataPacket[]>("SELECT VERSION() AS version, @@SESSION.sql_mode AS mode");
  const version = String(identity[0]!.version),
    priorMode = String(identity[0]!.mode),
    series = version.split(".").slice(0, 2).join(".");
  const { vocabulary } = (await import(`../../packages/mysql/src/vocabulary/generated/${series}.js`)) as {
    vocabulary: MySqlVocabulary;
  };
  const [keywords] = await connection.query<RowDataPacket[]>(
    "SELECT WORD AS name, RESERVED AS reserved FROM INFORMATION_SCHEMA.KEYWORDS",
  );
  const sort = <T extends { name: string }>(rows: readonly T[]) =>
    [...rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const referenceLookup = vocabulary.forMode();
  strict.deepEqual(
    sort(keywords.map((row) => ({ name: String(row.name), reserved: Number(row.reserved) }))),
    sort(
      vocabulary.declarations
        .map(([name]) => referenceLookup(name)!)
        .filter((word) => word.group !== "function")
        .map((word) => ({ name: word.name, reserved: Number(word.reserved) })),
    ),
    "Complete source reservation metadata must match the native keyword API",
  );
  const [routines] = await connection.query<RowDataPacket[]>(
    "SELECT ROUTINE_NAME AS name FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() AND ROUTINE_TYPE='FUNCTION'",
  );
  const stored = new Set(routines.map((row) => String(row.name).toUpperCase()));
  const prepare = async (sql: string): Promise<boolean> => {
    try {
      await connection.prepare(sql);
      connection.unprepare(sql);
      return true;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (
        ![
          "ER_PARSE_ERROR",
          "ER_SP_DOES_NOT_EXIST",
          "ER_FUNC_INEXISTENT_NAME_COLLISION",
          "ER_WRONG_PARAMCOUNT_TO_NATIVE_FCT",
          "ER_WRONG_PARAMETERS_TO_NATIVE_FCT",
          "ER_WRONG_PARAMCOUNT_TO_PROCEDURE",
        ].includes(code ?? "")
      )
        throw error;
      return false;
    }
  };
  const failures: string[] = [];
  let probes = 0;
  try {
    for (const sqlMode of ["", "IGNORE_SPACE"]) {
      await connection.query("SET SESSION sql_mode = ?", [sqlMode]);
      const lookup = vocabulary.forMode(sqlMode);
      for (const [upper] of vocabulary.declarations) {
        const word = lookup(upper)!,
          name = upper.toLowerCase(),
          identifier = !word.reserved,
          bareColumn = identifier && !word.infix;
        const cases = [
          [`SELECT 1 AS ${name}`, identifier],
          [`SELECT fixture.\`${name}\` FROM (SELECT 1 ${name}) AS fixture`, bareColumn],
          [`WITH seed AS (SELECT 1 AS n), ${name} AS (SELECT 1 AS n) SELECT n FROM ${name}`, identifier],
          [`WITH fixture AS (SELECT 1 AS value) SELECT value FROM fixture AS ${name}`, identifier],
          [`WITH fixture AS (SELECT 1 AS value) SELECT value FROM fixture ${name}`, identifier],
          [`WITH fixture AS (SELECT 1 AS \`${name}\`) SELECT fixture.${name} AS value FROM fixture`, true],
          [`WITH \`${name}\` AS (SELECT 1 AS value) SELECT value FROM \`${name}\``, true],
        ] as const;
        for (const [sql, expected] of cases) {
          const actual = await prepare(sql);
          probes++;
          if (actual !== expected)
            failures.push(`${upper}:${sqlMode || "ordinary"}:${sql}:native=${actual},source=${expected}`);
        }
      }
      for (const [name] of vocabulary.declarations) {
        if (lookup(name)!.group !== "function" || stored.has(name)) continue;
        let args: string | undefined;
        for (let count = 0; count <= 5; count++) {
          const candidate = Array(count).fill("NULL").join(",");
          if (await prepare(`SELECT ${name}(${candidate}) AS value`)) {
            args = candidate;
            break;
          }
        }
        // Functions with special productions need independent signature/syntax evidence.
        if (args === undefined) continue;
        const spaced = await prepare(`SELECT ${name} (${args}) AS value`);
        const quoted = await prepare(`SELECT \`${name}\`(${args}) AS value`);
        if (spaced !== (sqlMode === "IGNORE_SPACE")) failures.push(`function-space:${name}:${sqlMode}`);
        if (quoted) failures.push(`function-quoted:${name}:${sqlMode}`);
      }
    }
    strict.deepEqual(
      failures,
      [],
      `Native ${series} identifier contexts and function bindings (${probes} source-driven identifier probes)`,
    );
  } finally {
    await connection.query("SET SESSION sql_mode = ?", [priorMode]);
  }
}
