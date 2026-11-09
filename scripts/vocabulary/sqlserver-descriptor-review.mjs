import assert from "node:assert/strict";

/** Require complete, cleaned-up captures for every compatibility target; capture mode never approves them. */
export function reviewSqlServerDescriptors(report, approved) {
  assert.equal(report.formatVersion, 1);
  assert.equal(approved.formatVersion, 1);
  assert.equal(report.caseStatus, "passed", "SQL Server descriptor capture incomplete");
  assert.equal(report.cleanupStatus, "passed", "SQL Server descriptor cleanup incomplete");
  assert.ok([14, 15, 16, 17].includes(report.major));
  assert.match(report.build, /^\d+\.\d+\.\d+\.\d+$/u);
  assert.equal(Number(report.build.split(".")[0]), report.major);
  const levels = [140, 150, 160, 170].filter((level) => level <= report.major * 10);
  assert.deepEqual(
    report.profiles.map(({ compatibility }) => compatibility),
    levels,
    "SQL Server descriptor compatibility targets missing or duplicated",
  );
  for (const profile of report.profiles) {
    const key = `${report.build}:${profile.compatibility}`;
    const expected = approved.profiles[key];
    assert.ok(expected, `Unreviewed SQL Server descriptor profile ${key}; capture and review explicitly`);
    assert.equal(profile.stage, "complete");
    assert.equal(expected.major, report.major);
    assert.equal(expected.build, report.build);
    assert.equal(expected.compatibility, profile.compatibility);
    assert.equal(profile.inventory.length, expected.catalogNames, `SQL Server descriptor catalog drift: ${key}`);
    assert.equal(profile.cases.length, expected.cases, `SQL Server descriptor witness drift: ${key}`);
    assert.equal(
      profile.observations.length,
      expected.observations,
      `SQL Server descriptor observations missing: ${key}`,
    );
    const counts = {};
    for (const observation of profile.observations) {
      const outcome = `${observation.independent.status}/${observation.adapter.status}`;
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    assert.deepEqual(counts, profile.counts, `SQL Server descriptor accounting inconsistent: ${key}`);
    assert.deepEqual(counts, expected.counts, `SQL Server descriptor outcome drift: ${key}`);
    assert.match(profile.observationDigest, /^[a-f0-9]{64}$/u);
    assert.equal(profile.observationDigest, expected.observationDigest, `SQL Server native descriptor drift: ${key}`);
  }
}
