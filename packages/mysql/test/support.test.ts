import { describe, it, strict } from "poku";
import { assertMySqlServerEvidence, mySqlServerEvidence } from "../src/capabilities.js";
import { MYSQL_SUPPORT_POLICY, mySqlVersionSupport, parseMySqlVersion } from "../src/support.js";

await describe("MySQL support policy", async () => {
  await it("publishes immutable LTS and innovation targets", () => {
    strict.deepStrictEqual(MYSQL_SUPPORT_POLICY.stable, [
      { series: "8.4", matrixVersion: "8.4.12" },
      { series: "9.7", matrixVersion: "9.7.3" },
    ]);
    strict.deepStrictEqual(MYSQL_SUPPORT_POLICY.canary, {
      series: "26.7",
      matrixVersion: "26.7.1",
      channel: "innovation",
    });
    strict.strictEqual(MYSQL_SUPPORT_POLICY.patchCompatibility, "within-lts-series");
    strict.strictEqual(MYSQL_SUPPORT_POLICY.upstreamSupportWindow, "premier-and-extended");
    strict.strictEqual(MYSQL_SUPPORT_POLICY.deprecation.noticeBeforeUpstreamEndDays, 90);
    strict.ok(Object.isFrozen(MYSQL_SUPPORT_POLICY));
    strict.ok(Object.isFrozen(MYSQL_SUPPORT_POLICY.stable));
    strict.ok(MYSQL_SUPPORT_POLICY.stable.every(Object.isFrozen));
  });

  await it("classifies exact versions without promoting innovation releases implicitly", () => {
    strict.deepStrictEqual(parseMySqlVersion("9.7.3-commercial"), [9, 7, 3]);
    strict.strictEqual(parseMySqlVersion("9.7"), undefined);
    strict.strictEqual(mySqlVersionSupport("8.4.0"), "supported");
    strict.strictEqual(mySqlVersionSupport("9.7.99"), "supported");
    strict.strictEqual(mySqlVersionSupport("8.0.44"), "below-supported");
    strict.strictEqual(mySqlVersionSupport("9.6.0"), "unsupported-line");
    strict.strictEqual(mySqlVersionSupport("26.7.1"), "unsupported-line");
    strict.strictEqual(mySqlVersionSupport("26.7.1", "canary"), "canary");
    strict.strictEqual(mySqlVersionSupport("26.7.2-rc1"), "prerelease");
    strict.strictEqual(mySqlVersionSupport("26.7.2-rc1", "canary"), "canary");
    strict.strictEqual(mySqlVersionSupport("27.7.0"), "newer-than-tested");
    strict.strictEqual(mySqlVersionSupport("unknown"), "unknown");
  });

  await it("normalizes semantic settings and rejects unidentified MySQL-compatible products", () => {
    const evidence = mySqlServerEvidence("9.7.3", {
      versionComment: "MySQL Enterprise Server - Commercial",
      sqlMode: "strict_trans_tables,ANSI_QUOTES,strict_trans_tables",
      characterSetServer: " UTF8MB4 ",
      collationServer: "UTF8MB4_0900_AI_CI",
      characterSetConnection: "UTF8MB4",
      collationConnection: "UTF8MB4_BIN",
      timeZone: " system ",
      systemTimeZone: "America/Sao_Paulo",
      lowerCaseTableNames: "1",
    });
    strict.deepStrictEqual(evidence, {
      product: "mysql",
      version: "9.7.3",
      versionKey: "9.7.3",
      features: [],
      settings: {
        characterSetConnection: "utf8mb4",
        characterSetServer: "utf8mb4",
        collationConnection: "utf8mb4_bin",
        collationServer: "utf8mb4_0900_ai_ci",
        edition: "enterprise",
        lowerCaseTableNames: 1,
        sqlMode: "ANSI_QUOTES,STRICT_TRANS_TABLES",
        systemTimeZone: "America/Sao_Paulo",
        timeZone: "SYSTEM",
      },
    });
    assertMySqlServerEvidence(evidence);
    strict.strictEqual(
      mySqlServerEvidence("8.4.12", { versionComment: "Percona Server", sqlMode: "" }).product,
      "mysql-compatible",
    );
    strict.strictEqual(
      mySqlServerEvidence("8.4.12", { versionComment: "Source distribution", sqlMode: "" }).settings.edition,
      "source",
    );
    strict.strictEqual(
      mySqlServerEvidence("8.4.12", { versionComment: "MySQL Commercial", sqlMode: "" }).settings.edition,
      "commercial",
    );
    strict.strictEqual(
      mySqlServerEvidence("8.4.12", { versionComment: "MySQL custom build", sqlMode: "" }).settings.edition,
      "unknown",
    );
    strict.throws(() => mySqlServerEvidence("8.4.12", { characterSetServer: "utf8mb4; DROP" }), /safe identifier/u);
    strict.throws(() => mySqlServerEvidence("8.4.12", { timeZone: "\u0000" }), /time-zone/u);
    strict.throws(() => mySqlServerEvidence("8.4.12", { lowerCaseTableNames: 3 }), /must be 0, 1, or 2/u);
  });

  await it("validates allowlisted evidence independently of snapshot parsing", () => {
    const base = mySqlServerEvidence("8.4.12", "");
    for (const [settings, pattern] of [
      [{ sqlMode: "strict_trans_tables" }, /normalized mode/u],
      [{ characterSetServer: "UTF8MB4" }, /normalized identifier/u],
      [{ timeZone: " system " }, /must be normalized/u],
      [{ lowerCaseTableNames: 3 }, /must be 0, 1, or 2/u],
      [{ edition: "custom" }, /edition evidence/u],
      [{ unknownSetting: true }, /non-allowlisted/u],
    ] as const) {
      strict.throws(() => assertMySqlServerEvidence({ ...base, settings }), pattern);
    }
    strict.throws(
      () => assertMySqlServerEvidence({ ...base, features: ["proxy:unknown"] }),
      /does not allow feature identifiers/u,
    );
  });
});
