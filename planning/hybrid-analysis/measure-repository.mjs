import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const git = (...args) =>
  execFileSync("git", args, {
    cwd: root,
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
const revision = (ref) => git("rev-parse", `${ref}^{commit}`).toString().trim();
const refs = {
  base: revision("3753571154bb3acf460a2a2031e9b20f88e21ea8"),
  exhaustiveProposal: revision("e194abb4f55523f435995a74d7d8ab58c2c42977"),
  current: revision(process.argv[2] ?? "HEAD"),
};
const binaryExtensions = new Set(
  ".png .jpg .jpeg .gif .webp .avif .ico .pdf .zip .gz .tgz .br .mp4 .mov .webm .mp3 .wav .woff .woff2 .ttf .wasm .node .vsix".split(
    " ",
  ),
);
const sourceExtensions = new Set(
  ".ts .tsx .mts .cts .js .jsx .mjs .cjs .rs .vue .svelte .sql .css .scss .html .py .sh .bash .go .c .h .cpp .hpp .graphql".split(
    " ",
  ),
);
function tree(ref) {
  return git("ls-tree", "-rz", "--long", "--full-tree", ref)
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) blob ([a-f\d]+)\s+(\d+)\t(.+)$/su.exec(line);
      if (!match) throw Error(`Unsupported tracked entry: ${line}`);
      return { mode: match[1], blob: match[2], bytes: Number(match[3]), path: match[4] };
    });
}
const trees = Object.fromEntries(Object.entries(refs).map(([label, ref]) => [label, tree(ref)]));
const requested = new Set(
  Object.values(trees)
    .flat()
    .filter((entry) => entry.mode !== "120000" && !binaryExtensions.has(extname(entry.path).toLowerCase()))
    .map((entry) => entry.blob),
);
const batch = execFileSync("git", ["cat-file", "--batch"], {
  cwd: root,
  input: `${[...requested].join("\n")}\n`,
  maxBuffer: 512 * 1024 * 1024,
});
const bodies = new Map();
let offset = 0;
for (const expected of requested) {
  const end = batch.indexOf(10, offset);
  const [blob, kind, size] = batch.subarray(offset, end).toString().split(" ");
  if (blob !== expected || kind !== "blob") throw Error("Git batch object framing differs");
  const bytes = Number(size);
  const body = batch.subarray(end + 1, end + 1 + bytes);
  if (batch[end + 1 + bytes] !== 10) throw Error("Git batch object length differs");
  let text;
  if (!body.includes(0)) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      // Invalid UTF-8 is binary for physical text-line accounting.
    }
  }
  const preamble = [];
  for (const line of text?.split("\n").slice(0, 12) ?? []) {
    if (line.trim() && !/^\s*(?:\/\/|\/\*|\*|#|<!--)/u.test(line)) break;
    preamble.push(line);
  }
  const generated = preamble.some((line) =>
    /(?:@generated|auto[- ]generated|automatically generated|generated (?:by|from|file|code))/iu.test(line),
  );
  bodies.set(blob, {
    binary: text === undefined,
    generated,
    lines: text === undefined || !text.length ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
  });
  offset = end + 1 + bytes + 1;
}
if (offset !== batch.length) throw Error("Unconsumed Git batch data");

function classify(path) {
  if (sourceExtensions.has(extname(path)) || /(?:^|\/)(?:Containerfile|Dockerfile|Makefile)$/u.test(path)) {
    if (/^packages\/[^/]+\/src\//u.test(path)) return { category: "packageSource", code: true };
    if (/^(?:test|e2e)\//u.test(path) || /\/(?:test|tests)\//u.test(path))
      return { category: "testSource", code: true };
    if (/^(?:scripts|tools)\//u.test(path)) return { category: "toolingSource", code: true };
    if (/^(?:examples|editors|website)\//u.test(path))
      return { category: "applicationEditorWebsiteSource", code: true };
    return { category: "otherSource", code: true };
  }
  if (/\.md$/u.test(path)) return { category: "documentation", code: false };
  if (/^grammar\/[^/]+\/facts\/.*\.json$/u.test(path)) return { category: "capturedCatalogData", code: false };
  if (/^(?:grammar\/|test\/fixtures\/|planning\/).*\.json$/u.test(path))
    return { category: "auditFixtureAndReportData", code: false };
  if (/\.(?:json|ya?ml|toml)$/u.test(path)) return { category: "configurationAndOtherData", code: false };
  return { category: "otherText", code: false };
}
const empty = () => ({ files: 0, bytes: 0, lines: 0, maintainedCodeLines: 0, generatedCodeLines: 0 });
function add(target, entry, facts, code) {
  target.files++;
  target.bytes += entry.bytes;
  target.lines += facts.lines;
  if (code) target[facts.generated ? "generatedCodeLines" : "maintainedCodeLines"] += facts.lines;
}
const rows = {};
for (const [label, entries] of Object.entries(trees)) {
  const totals = empty(),
    categories = {},
    packages = {},
    generated = [],
    data = [];
  for (const entry of entries) {
    let facts = bodies.get(entry.blob);
    let category, code;
    if (entry.mode === "120000") {
      category = "symlink";
      code = false;
      facts = { lines: 0 };
    } else if (binaryExtensions.has(extname(entry.path).toLowerCase()) || facts.binary) {
      category = "binary";
      code = false;
      facts = { lines: 0 };
    } else ({ category, code } = classify(entry.path));
    add(totals, entry, facts, code);
    categories[category] ??= empty();
    add(categories[category], entry, facts, code);
    if (category === "packageSource") {
      const name = entry.path.split("/")[1];
      packages[name] ??= empty();
      add(packages[name], entry, facts, code);
    }
    if (code && facts.generated) generated.push({ path: entry.path, lines: facts.lines, bytes: entry.bytes });
    if (category === "capturedCatalogData" || category === "auditFixtureAndReportData")
      data.push({ path: entry.path, lines: facts.lines, bytes: entry.bytes });
  }
  const expectedBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (totals.files !== entries.length || totals.bytes !== expectedBytes)
    throw Error(`Tracked-file accounting differs for ${label}`);
  rows[label] = {
    revision: refs[label],
    totals,
    categories: Object.fromEntries(Object.entries(categories).sort(([a], [b]) => a.localeCompare(b))),
    packages: Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b))),
    generatedSourceFiles: generated.length,
    largestGeneratedSources: generated.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path)).slice(0, 12),
    largestTrackedData: data.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path)).slice(0, 12),
  };
}
const diff = (from, to) => ({
  netTrackedLines: rows[to].totals.lines - rows[from].totals.lines,
  netMaintainedCodeLines: rows[to].totals.maintainedCodeLines - rows[from].totals.maintainedCodeLines,
  netGeneratedCodeLines: rows[to].totals.generatedCodeLines - rows[from].totals.generatedCodeLines,
});
// Diff commands take exact revisions; category deltas take the named inventory rows.
const comparison = (from, to) => {
  const changes = git("diff", "--numstat", refs[from], refs[to]).toString().trim().split("\n").filter(Boolean);
  let additions = 0,
    deletions = 0,
    binaryChanges = 0;
  for (const line of changes) {
    const [added, removed] = line.split("\t");
    if (added === "-" || removed === "-") binaryChanges++;
    else {
      additions += Number(added);
      deletions += Number(removed);
    }
  }
  return {
    ...diff(from, to),
    shortstat: git("diff", "--shortstat", refs[from], refs[to]).toString().trim(),
    additions,
    deletions,
    binaryChanges,
    physicalLineDeltaMatchesGitDiff: rows[to].totals.lines - rows[from].totals.lines === additions - deletions,
  };
};
const report = {
  formatVersion: 1,
  sourceRevision: refs.current,
  measurementToolDigest: createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest("hex"),
  method: {
    scope: "All Git-tracked files at exact revisions; no working-tree, build-output or installed-package files.",
    lines:
      "Physical UTF-8 text lines, including blank lines and comments. Not semantic statements or changed-line counts.",
    generatedCode:
      "Code files with an explicit generated/auto-generated/@generated header in the leading comment preamble (at most twelve lines). Data and reports remain separately classified.",
    maintainedCode: "Code files without that header; generated blocks inside maintained files are not separated.",
    sourceExtensions: [...sourceExtensions].sort(),
    binary:
      "Known binary extensions or NUL/invalid UTF-8; bytes/files count, lines do not. Symlink targets count as bytes, not source lines.",
    limits:
      "Classification measures tracked ownership and size, not hand-editing effort, dead code, semantic coverage, publication payload or tree-shaken bytes.",
  },
  rows,
  comparisons: {
    originalProposal: comparison("base", "exhaustiveProposal"),
    currentProposal: comparison("base", "current"),
    directionChange: comparison("exhaustiveProposal", "current"),
  },
};
const output = resolve(root, process.argv[3] ?? "planning/hybrid-analysis/repository-measurements.json");
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ revisions: refs, comparisons: report.comparisons })}\n`);
