import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, formatGenerated } from "./vocabulary/common.mjs";
import { reconcileSqlServerVocabulary } from "./vocabulary/sqlserver-review.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const [sourceRevision, run, ...paths] = process.argv.slice(2);
assert.match(sourceRevision ?? "", /^[a-f0-9]{40}$/u);
assert.match(run ?? "", /^[1-9][0-9]*$/u);
assert.ok(paths.length, "Supply all native catalog artifacts after reviewing source disagreements");
const producer = execFileSync("git", ["show", `${sourceRevision}:scripts/vocabulary/sqlserver-probes.mjs`], {
  cwd: root,
});
const facts = JSON.parse(await readFile(join(root, "grammar/sqlserver/vocabulary/facts.json"), "utf8"));
const qualification = reconcileSqlServerVocabulary({
  facts,
  sourceRevision,
  run,
  producerDigest: digest(producer),
  reports: await Promise.all(paths.map(async (path) => ({ file: basename(path), bytes: await readFile(path) }))),
});
await writeFile(
  join(root, "grammar/sqlserver/vocabulary/qualification.json"),
  formatGenerated(root, "qualification.json", JSON.stringify(qualification)),
);
console.log(
  `Reconciled ${qualification.profiles.length} SQL Server native scopes; ${qualification.common.length} shared source deltas and ${qualification.profiles.reduce((sum, profile) => sum + profile.overrides.length, 0)} scoped deltas`,
);
