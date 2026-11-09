import type { Pool } from "pg";
import { strict } from "poku";
import { parsePostgresMajor } from "../../packages/postgres/src/support.js";
import type { PostgresVocabulary } from "../../packages/postgres/src/vocabulary/types.js";

/** Independent native metadata and parsing oracle; no prepared candidate is executed. */
export async function assertPostgresVocabulary(pool: Pool, version: string): Promise<void> {
  const major = parsePostgresMajor(version);
  if (major === undefined) throw Error("Missing actual PostgreSQL keyword profile");
  const { vocabulary } = (await import(`../../packages/postgres/src/vocabulary/generated/${major}.js`)) as {
    vocabulary: PostgresVocabulary;
  };
  const rows = (
    await pool.query<{ word: string; catcode: string; barelabel: boolean }>(
      "SELECT word, catcode, barelabel FROM pg_catalog.pg_get_keywords()",
    )
  ).rows;
  const codes = { UNRESERVED_KEYWORD: "U", COL_NAME_KEYWORD: "C", TYPE_FUNC_NAME_KEYWORD: "T", RESERVED_KEYWORD: "R" };
  const sort = <T extends { word: string }>(values: readonly T[]) =>
    [...values].sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
  strict.deepEqual(
    sort(rows),
    sort(
      vocabulary.words.map((word) => ({ word: word.name, catcode: codes[word.category], barelabel: word.bareLabel })),
    ),
    "Complete generated keyword classes must match the actual engine inventory",
  );
  const client = await pool.connect();
  const statement = "__typed_sql_vocabulary_probe";
  let prepared = false;
  try {
    const prepare = async (text: string) => {
      await client.query(`PREPARE ${statement} AS ${text}`);
      prepared = true;
      await client.query(`DEALLOCATE ${statement}`);
      prepared = false;
    };
    for (const word of vocabulary.words) {
      await prepare(`SELECT 1 AS ${word.name}`);
      // A postfix expression can parse successfully without assigning a bare label.
      const bareAlias = `SELECT fixture."${word.name}" FROM (SELECT 1 ${word.name}) AS fixture`;
      if (word.bareLabel) await prepare(bareAlias);
      else
        await strict.rejects(prepare(bareAlias), (error: unknown) =>
          ["42601", "42703"].includes((error as { code?: string }).code ?? ""),
        );
      await prepare(`WITH fixture AS (SELECT 1 AS "${word.name}") SELECT fixture.${word.name} AS value FROM fixture`);
      const sql = `WITH seed AS (SELECT 1 AS n), ${word.name} AS (SELECT 1 AS value) SELECT value FROM ${word.name}`;
      if (word.category === "UNRESERVED_KEYWORD" || word.category === "COL_NAME_KEYWORD") {
        await prepare(sql);
        await prepare(`WITH fixture AS (SELECT 1 AS "${word.name}") SELECT ${word.name} AS value FROM fixture`);
      } else await strict.rejects(prepare(sql), (error: unknown) => (error as { code?: string }).code === "42601");
    }
    await prepare("WITH fixture AS (SELECT 1 AS \"Key\", 'text' AS key) SELECT Key AS value FROM fixture");
    await strict.rejects(
      prepare("SELECT ſum(1::integer) AS value"),
      (error: unknown) => (error as { code?: string }).code === "42883",
    );
  } finally {
    if (prepared) await client.query(`DEALLOCATE ${statement}`);
    client.release();
  }
}
