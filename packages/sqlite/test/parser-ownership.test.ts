import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { assertOwnedParserCorpus, type OwnedParserCorpusApi } from "../../../test/helpers/parser-corpus.js";
import { parseStatement, SqlParseError, tokenize, walkStatement } from "../src/parser/index.js";

await describe("SQLite-owned parser", async () => {
  await it("owns SQLite ASTs without compatibility-parser or vendor-mode switches", async () => {
    for (const source of [
      "SELECT [account].[id], `account`.`email` FROM [account] WHERE [id] = ?",
      "SELECT 1 UNION ALL SELECT 2 EXCEPT SELECT 3 ORDER BY 1 LIMIT 1",
      "UPDATE account SET email = ? WHERE id = ? RETURNING id",
      "WITH selected AS (SELECT id FROM account) DELETE FROM account WHERE id IN (SELECT id FROM selected)",
    ]) {
      const statement = parseStatement(source);
      strict.ok(Object.isFrozen(statement));
      strict.ok(Object.isFrozen(statement.range));
    }
    const implementation = `${await readFile(new URL("../src/parser/parser.ts", import.meta.url), "utf8")}\n${await readFile(new URL("../src/parser/tokenizer.ts", import.meta.url), "utf8")}`;
    strict.ok(!implementation.includes("#syntax"));
    strict.ok(!implementation.includes('syntax === "postgres"'));
    strict.ok(!implementation.includes('syntax !== "mysql"'));
  });

  await it("retains bounded deterministic diagnostics and SQLite lexical behavior", () => {
    strict.strictEqual(tokenize("SELECT [account].id WHERE id = ?")[1]?.kind, "quoted-identifier");
    const compound = parseStatement("SELECT 1 UNION ALL SELECT 2 EXCEPT SELECT 3");
    strict.strictEqual(compound.kind, "select");
    if (compound.kind === "select") {
      strict.deepStrictEqual(
        compound.compounds.map(({ operator, all }) => [operator, all]),
        [
          ["union", true],
          ["except", false],
        ],
      );
      strict.ok(compound.compounds.every(({ statement }) => statement.compounds.length === 0));
    }
    strict.throws(
      () => parseStatement("SELECT 1 EXCEPT ALL SELECT 2"),
      (error: unknown) => error instanceof SqlParseError && /does not support EXCEPT ALL/u.test(error.message),
    );
    strict.throws(() => parseStatement("(SELECT 1) UNION SELECT 2"), SqlParseError);
    strict.doesNotThrow(() => parseStatement("SELECT value FROM (SELECT 1 AS value UNION SELECT 2) values_set"));
  });

  await it("owns complete SQLite window-frame syntax", () => {
    const statement = parseStatement(
      "SELECT SUM(score) OVER chained AS total FROM account " +
        "WINDOW base AS (PARTITION BY email ORDER BY id), " +
        "chained AS (base ROWS BETWEEN 2 PRECEDING AND 1 FOLLOWING EXCLUDE TIES)",
    );
    strict.strictEqual(statement.kind, "select");
    if (statement.kind !== "select") return;
    const chained = statement.windows[1]?.specification;
    strict.strictEqual(chained?.base?.name, "base");
    strict.strictEqual(chained?.frame?.unit, "rows");
    strict.strictEqual(chained?.frame?.start.kind, "preceding");
    strict.strictEqual(chained?.frame?.end.kind, "following");
    strict.strictEqual(chained?.frame?.exclude, "ties");
    strict.throws(
      () => parseStatement("SELECT SUM(score) OVER (ROWS BETWEEN UNBOUNDED FOLLOWING AND CURRENT ROW) FROM account"),
      (error: unknown) =>
        error instanceof SqlParseError && /cannot start with UNBOUNDED FOLLOWING/u.test(error.message),
    );
    strict.throws(
      () => parseStatement("SELECT SUM(score) OVER (ROWS BETWEEN CURRENT ROW AND 1 PRECEDING) FROM account"),
      (error: unknown) => error instanceof SqlParseError && /end cannot precede its start/u.test(error.message),
    );
  });

  await it("owns SQLite conflict algorithms and chained UPSERT clauses", () => {
    for (const source of [
      "INSERT OR ROLLBACK INTO account (id, email) VALUES (?, ?)",
      "INSERT OR ABORT INTO account (id, email) VALUES (?, ?)",
      "INSERT OR FAIL INTO account (id, email) VALUES (?, ?)",
      "INSERT OR IGNORE INTO account (id, email) VALUES (?, ?)",
      "INSERT OR REPLACE INTO account (id, email) VALUES (?, ?)",
      "REPLACE INTO account (id, email) VALUES (?, ?)",
      "UPDATE OR IGNORE account SET email = ? WHERE id = ?",
    ]) {
      strict.doesNotThrow(() => parseStatement(source), source);
    }
    const statement = parseStatement(
      "INSERT INTO account (id, email) VALUES (?, ?) " +
        "ON CONFLICT (email COLLATE nocase ASC) WHERE email IS NOT NULL " +
        "DO UPDATE SET email = excluded.email WHERE excluded.id > 0 " +
        "ON CONFLICT DO NOTHING RETURNING id, email",
    );
    strict.strictEqual(statement.kind, "insert");
    if (statement.kind !== "insert") return;
    strict.strictEqual(statement.upserts.length, 2);
    strict.strictEqual(statement.upserts[0]?.target[0]?.collation?.name, "nocase");
    strict.strictEqual(statement.upserts[0]?.action.kind, "update");
    strict.strictEqual(statement.upserts[1]?.action.kind, "nothing");
    strict.throws(
      () => parseStatement("INSERT INTO account (id) VALUES (?) ON CONFLICT DO UPDATE SET id = excluded.id"),
      (error: unknown) => error instanceof SqlParseError && /requires a conflict target/u.test(error.message),
    );
  });

  await it("passes the characterized parser, tokenizer, walker, and fuzz corpus", () => {
    assertOwnedParserCorpus({
      dialect: "sqlite",
      parseStatement: (source, options) =>
        parseStatement(source, options) as unknown as ReturnType<OwnedParserCorpusApi["parseStatement"]>,
      tokenize,
      walkStatement: (statement, visitor) =>
        walkStatement(
          statement as unknown as Parameters<typeof walkStatement>[0],
          visitor as Parameters<typeof walkStatement>[1],
        ),
      isParseError: (error) => error instanceof SqlParseError,
      compareWithCompatibilityParser: false,
    });
  });
});
