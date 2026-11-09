import { execFile as callback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";
import { commerceFiles } from "../../website/.vitepress/theme/playground/commerce-example.js";
import { writeNetworkDenialPreload } from "../helpers/network-denial.js";

const execFile = promisify(callback);
await describe("native application admission audit", async () => {
  await it("accounts for every declared grammar and maintained query without native initialization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-native-admission-"));
    try {
      const preload = join(directory, "deny-network.mjs");
      const output = join(directory, "report.json");
      await writeNetworkDenialPreload(preload, "Admission audit must remain offline", true);
      await execFile(process.execPath, [
        "--import",
        preload,
        "--import",
        "tsx",
        "planning/hybrid-analysis/audit-native-admission.mjs",
        output,
      ]);
      const report = JSON.parse(await readFile(output, "utf8"));
      const ledger = JSON.parse(await readFile("grammar/features/ledger.json", "utf8"));
      strict.deepEqual(
        report.profiles.map((profile: { grammar: string }) => profile.grammar),
        Object.keys(ledger.dialects).sort(),
      );
      strict.equal(report.transportFactoryCalls, 0);
      strict.equal(report.networkDenial.installed, true);
      strict.equal(report.networkDenial.attempts, 0);
      for (const profile of report.profiles) {
        const files = commerceFiles(profile.grammar);
        const expected = Object.keys(files)
          .filter((file) => file.startsWith("queries/") && /\.(?:ts|sql)$/u.test(file))
          .sort();
        strict.deepEqual(profile.queries.map((query: { file: string }) => query.file).sort(), expected);
        strict.equal(
          profile.summary.finiteCandidates,
          profile.summary.admitted + profile.summary.declined + profile.summary.unavailable,
        );
        for (const query of profile.queries) {
          for (const candidate of query.candidates) {
            strict.equal(candidate.nativeQualification, "not-attempted");
            strict.equal(candidate.sqlDigest, createHash("sha256").update(candidate.sql).digest("hex"));
            if (!query.complete || profile.availability.status === "unavailable")
              strict.equal(
                candidate.admission.accepted,
                null,
                "Unavailable evidence cannot become a successful admission",
              );
            for (const occurrence of candidate.parameterOccurrences)
              strict.ok(occurrence.index >= 1 && occurrence.index <= candidate.logicalParameterCount);
          }
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
