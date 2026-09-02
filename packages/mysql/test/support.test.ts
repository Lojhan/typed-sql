import { describe, it, strict } from "poku";
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
});
