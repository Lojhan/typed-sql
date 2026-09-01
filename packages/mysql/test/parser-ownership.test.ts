import { describe, it, strict } from "poku";
import { assertOwnedParserCorpus } from "../../../test/helpers/parser-corpus.js";
import { parseStatement as parseCompatibilityStatement } from "../../ast/src/index.js";
import { parseStatement, SqlParseError, tokenize, walkStatement } from "../src/parser/index.js";

await describe("MySQL-owned parser", async () => {
  await it("matches the transition corpus without using the compatibility parser in production", () => {
    for (const source of [
      "SELECT `user`.id FROM `users` AS `user` WHERE id = ? LIMIT 5, 10",
      "SELECT id FROM users LOCK IN SHARE MODE",
      "SELECT id FROM users FOR UPDATE SKIP LOCKED",
      "INSERT INTO users (id) VALUES (?) RETURNING id",
    ]) {
      const statement = parseStatement(source);
      strict.deepStrictEqual(statement, parseCompatibilityStatement(source, { syntax: "mysql" }));
      strict.ok(Object.isFrozen(statement));
      strict.ok(Object.isFrozen(statement.range));
    }
  });

  await it("retains bounded deterministic diagnostics and MySQL lexical behavior", () => {
    strict.strictEqual(tokenize('SELECT "text", `user`.id WHERE id = ?')[1]?.kind, "string");
    strict.throws(
      () => parseStatement("SELECT 1", { maxTokens: 1 }),
      (error: unknown) => error instanceof SqlParseError && error.code === "TSQ002",
    );
  });

  await it("passes the characterized parser, tokenizer, walker, and fuzz corpus", () => {
    assertOwnedParserCorpus({
      dialect: "mysql",
      parseStatement,
      tokenize,
      walkStatement,
      isParseError: (error) => error instanceof SqlParseError,
    });
  });
});
