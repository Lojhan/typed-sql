import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { parseGrammarFeatureLedger } from "../../packages/conformance/src/index.js";
import { MYSQL_SUPPORT_POLICY } from "../../packages/mysql/src/index.js";

const workspace = process.cwd();

await describe("MySQL completeness review", async () => {
  await it("keeps the public support policy aligned with the canonical ledger", async () => {
    const ledger = parseGrammarFeatureLedger(
      JSON.parse(await readFile(join(workspace, "grammar", "features", "ledger.json"), "utf8")) as unknown,
    );
    strict.deepStrictEqual(
      ledger.dialects.mysql?.stable.map(({ minimum, maximum }) => ({ minimum, maximum })),
      MYSQL_SUPPORT_POLICY.stable.map(({ series }) => ({ minimum: series, maximum: series })),
    );
    strict.deepStrictEqual(ledger.dialects.mysql?.canary, [
      { minimum: MYSQL_SUPPORT_POLICY.canary.series, maximum: MYSQL_SUPPORT_POLICY.canary.series },
    ]);
    strict.deepStrictEqual(
      MYSQL_SUPPORT_POLICY.sqlModeProfiles.map(({ name }) => name),
      ["default", "lexical", "numeric"],
    );
    strict.strictEqual(MYSQL_SUPPORT_POLICY.customSqlModePolicy, "exact-only-for-modeled-modes");

    strict.deepStrictEqual(
      ledger.entries.filter(({ dialects }) => dialects.mysql === undefined).map(({ id }) => id),
      [],
      "every feature must classify MySQL",
    );
    strict.deepStrictEqual(
      ledger.entries.filter(({ dialects }) => dialects.mysql?.tests.length === 0).map(({ id }) => id),
      [],
      "every MySQL classification must have executable evidence",
    );
    strict.deepStrictEqual(
      ledger.entries
        .filter(({ dialects }) => dialects.mysql?.level === "unsupported" && dialects.mysql.diagnostic === undefined)
        .map(({ id }) => id),
      [],
      "every unsupported MySQL feature must have a stable diagnostic",
    );
    const missingTests = [];
    for (const entry of ledger.entries) {
      for (const test of entry.dialects.mysql?.tests ?? []) {
        try {
          await access(join(workspace, test.split("#", 1)[0]!));
        } catch {
          missingTests.push(`${entry.id}:${test}`);
        }
      }
    }
    strict.deepStrictEqual(missingTests, [], "every MySQL evidence file must exist");
  });

  await it("documents support, fail-closed modes, codecs, migration, and unsupported boundaries", async () => {
    const guide = await readFile(join(workspace, "docs", "dialects", "mysql.md"), "utf8");
    const mappings = await readFile(join(workspace, "docs", "reference", "type-mappings.md"), "utf8");
    const compatibility = await readFile(join(workspace, "docs", "reference", "compatibility.md"), "utf8");
    const readme = await readFile(join(workspace, "packages", "mysql", "README.md"), "utf8");

    for (const value of ["8.4.11", "9.7.2", "26.7.0", "TSQ407", "MariaDB", "typed-sql compat", "onWarning"])
      strict.ok(guide.includes(value), `MySQL guide is missing ${value}`);
    for (const value of ["zero-date", "fractional precision", "spatial types", "compatibilitySnapshot"])
      strict.ok(mappings.includes(value), `MySQL type mapping is missing ${value}`);
    for (const value of ["8.4 and 9.7 LTS", "26.7.0", "non-blocking innovation canary"])
      strict.ok(compatibility.includes(value), `compatibility reference is missing ${value}`);
    for (const value of ["8.4 and 9.7 LTS", "versionPolicy", "SQL-mode profiles"])
      strict.ok(readme.includes(value), `MySQL README is missing ${value}`);

    strict.ok(guide.includes("MySQL `JSON_TABLE` row sources also remain\nunsupported and fail closed"));
    strict.ok(!guide.includes("separately modeled `JSON_TABLE`"));
    strict.ok(!guide.includes("targets MySQL 8.4 LTS"));
  });

  await it("records every user-visible MySQL workstream in release notes", async () => {
    const workstreams = [
      ["mysql-support-policy.md", "grammar-owned MySQL LTS"],
      ["mysql-server-evidence.md", "normalized MySQL distribution"],
      ["mysql-mode-aware-parser.md", "ANSI_QUOTES"],
      ["mysql-query-structure.md", "recursive CTEs"],
      ["mysql-dml-completeness.md", "insert modifiers"],
      ["mysql-versioned-catalogs.md", "versioned MySQL built-in catalogs"],
      ["mysql-snapshot-v2-introspection.md", "schema format 2 introspection"],
      ["mysql-runtime-protocol-hardening.md", "per-connection snapshot compatibility"],
    ] as const;
    const changelog = await readFile(join(workspace, "packages", "mysql", "CHANGELOG.md"), "utf8");
    for (const [name, changelogEvidence] of workstreams) {
      let source: string;
      try {
        source = await readFile(join(workspace, ".changeset", name), "utf8");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        try {
          source = await readFile(join(workspace, ".changeset", "pre", name), "utf8");
        } catch (preError) {
          if (!(preError instanceof Error && "code" in preError && preError.code === "ENOENT")) throw preError;
          strict.ok(changelog.includes(changelogEvidence), `${name} must remain represented in the changelog`);
          continue;
        }
      }
      strict.ok(source.includes('"@typed-sql/mysql"'), `${name} must release @typed-sql/mysql`);
      strict.ok(source.length >= 140, `${name} must describe the public change`);
    }
  });
});
