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

  await it("applies SQL modes before tokenization", () => {
    strict.strictEqual(tokenize('SELECT "account"')[1]?.kind, "string");
    strict.strictEqual(tokenize('SELECT "account"', { sqlMode: "ANSI_QUOTES" })[1]?.kind, "quoted-identifier");
    strict.strictEqual(tokenize("SELECT 'line\\nnext'")[1]?.value, "line\nnext");
    strict.strictEqual(tokenize("SELECT 'line\\nnext'", { sqlMode: "NO_BACKSLASH_ESCAPES" })[1]?.value, "line\\nnext");
    strict.strictEqual(tokenize("SELECT 1 || 0")[2]?.value, "OR");
    strict.strictEqual(tokenize("SELECT 'a' || 'b'", { sqlMode: "PIPES_AS_CONCAT" })[2]?.value, "||");
    strict.strictEqual(tokenize("SELECT 1 # comment\n")[2]?.kind, "eof");
    strict.throws(
      () => tokenize("SELECT 1 /*!80000 + 1 */"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "TSQ401",
    );
  });

  await it("passes the characterized parser, tokenizer, walker, and fuzz corpus", () => {
    assertOwnedParserCorpus({
      dialect: "mysql",
      parseStatement,
      tokenize,
      walkStatement,
      isParseError: (error) => error instanceof SqlParseError,
      compareWithCompatibilityParser: false,
    });
  });
});
