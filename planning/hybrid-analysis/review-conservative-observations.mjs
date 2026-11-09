import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { hash } from "../../scripts/language-audit/inventory.mjs";
import { expandFindings, reviewLive } from "../../scripts/language-audit/live-baseline.mjs";

// Read-only review aid. It never accepts a baseline or treats native preparation as semantics.
const [before, ...files] = process.argv.slice(2);
assert.match(before ?? "", /^[a-f\d]{40}$/u, "Supply the full prior baseline commit and captured catalog JSON paths");
assert.ok(files.length);
const root = fileURLToPath(new URL("../../", import.meta.url));
const fromGit = (path) =>
  JSON.parse(execFileSync("git", ["show", `${before}:${path}`], { cwd: root, maxBuffer: 32 * 1024 * 1024 }));
const baselines = fromGit("test/fixtures/language-audit/live-baselines.json");
const findings = expandFindings(fromGit("test/fixtures/language-audit/native-findings.json"));
const targets = new Map();
let captures = 0;
for (const file of files) {
  const capture = JSON.parse(await readFile(file, "utf8"));
  for (const input of [capture, ...(capture.profiles ?? [])]) {
    const inventory = input.languageInventory,
      recognition = input.languageRecognition;
    assert.equal(hash(recognition.observations), recognition.fingerprint);
    assert.equal(inventory.recognition.fingerprint, recognition.fingerprint);
    const review = reviewLive(inventory, baselines);
    assert.deepEqual(review.changedCategories, ["recognition"]);
    if (targets.has(review.key))
      assert.equal(targets.get(review.key), recognition.fingerprint, "Repeated target observations disagree");
    targets.set(review.key, recognition.fingerprint);
    captures++;
    const previous = baselines.targets[review.key];
    assert.deepEqual(review.summary.recognition.counts, previous.recognition.counts);
    const old = findings.targets[review.key].observations;
    const current = recognition.observations.filter((row) =>
      ["native-valid-grammar-diagnostic", "native-valid-grammar-unknown"].includes(row.status),
    );
    assert.equal(old.length, current.length);
    const restore = new Map(),
      changed = [];
    for (let index = 0; index < old.length; index++) {
      const left = old[index],
        right = current[index];
      if (hash(left) === hash(right)) continue;
      assert.equal(right.status, "native-valid-grammar-diagnostic");
      assert.ok(left.diagnosticDetails.some((item) => item.code === "TSQ202" && item.severity === "error"));
      assert.equal(right.columns.length, left.columns.length);
      assert.ok(right.columns.length > 0);
      const weakened = left.columns.map((column) => {
        const { databaseType: _databaseType, ...retained } = column;
        return { ...retained, tsType: "unknown", runtimeType: "unknown", nullable: true };
      });
      assert.deepEqual(right.columns, weakened, "Result labels, spans and other fields must remain identical");
      assert.equal(
        hash({ ...right, columns: left.columns }),
        hash(left),
        "A change beyond conservative error-result columns needs separate review",
      );
      restore.set(right, left.columns);
      changed.push({ name: right.name, sql: right.sql, diagnostic: right.diagnostics });
    }
    assert.ok(changed.length);
    const restored = recognition.observations.map((row) =>
      restore.has(row) ? { ...row, columns: restore.get(row) } : row,
    );
    assert.equal(
      hash(restored),
      previous.recognition.fingerprint,
      "Restoring only diagnosed-result columns must reproduce the entire prior observation fingerprint",
    );
    console.log(
      JSON.stringify({
        dialect: inventory.dialect,
        target: review.summary.target,
        changed,
        restoredFingerprint: previous.recognition.fingerprint,
        captureDigest: hash(capture),
      }),
    );
  }
}
console.log(
  JSON.stringify({
    reviewedTargets: targets.size,
    captures,
    countsChanged: false,
    nativeMetadataChanged: false,
    diagnosticsChanged: false,
    acceptedCoverageAdded: false,
  }),
);
