import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const formatGenerated = (root, name, body) =>
  execFileSync(join(root, "node_modules/.bin/biome"), ["format", `--stdin-file-path=${name}`], {
    cwd: root,
    input: body,
  });
/** Only explicit refresh operations call this helper; owners validate exact repository/revision URLs. */
export async function lockedSource(root, pin) {
  assert.match(pin.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(Number.isSafeInteger(pin.bytes) && pin.bytes > 0 && pin.bytes < 1024 * 1024);
  const path = join(root, "node_modules/.cache/typed-sql-vocabulary", pin.digest.slice(7));
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const response = await fetch(pin.url, { signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, "Pinned vocabulary input unavailable");
    bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, pin.bytes);
    assert.equal(digest(bytes), pin.digest);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  assert.equal(bytes.length, pin.bytes);
  assert.equal(digest(bytes), pin.digest);
  return bytes.toString("utf8");
}

/** Share only byte-identical facts; context or version changes remain explicit deltas. */
export function factorKeywords(profiles) {
  assert.ok(profiles.length, "No vocabulary profiles");
  const snapshots = profiles.map((profile) => new Set(profile.words.map((row) => JSON.stringify(row))));
  const common = profiles[0].words.filter((row) => snapshots.every((snapshot) => snapshot.has(JSON.stringify(row))));
  const shared = new Set(common.map((row) => row[0]));
  return {
    common,
    profiles: profiles.map(({ words, ...profile }) => ({
      ...profile,
      words: words.filter((row) => !shared.has(row[0])),
    })),
  };
}
