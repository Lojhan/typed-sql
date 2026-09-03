import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const workspace = resolve(import.meta.dirname, "..");
const baseline = JSON.parse(await readFile(join(workspace, "mutation-baseline.json"), "utf8"));
const reportArgument = process.argv.indexOf("--report");
const reportFile = reportArgument < 0 ? undefined : resolve(workspace, process.argv[reportArgument + 1] ?? "");

function replaceOccurrence(source, search, replacement, occurrence = 1) {
  let offset = -1;
  let from = 0;
  for (let index = 0; index < occurrence; index += 1) {
    offset = source.indexOf(search, from);
    if (offset < 0) throw new Error(`Mutation anchor was not found for occurrence ${occurrence}: ${search}`);
    from = offset + search.length;
  }
  return `${source.slice(0, offset)}${replacement}${source.slice(offset + search.length)}`;
}

const results = [];
for (const mutant of baseline.mutants) {
  const temporary = await mkdtemp(join(workspace, ".mutation-pilot-"));
  try {
    const sourceRoot = join(temporary, "packages/core");
    await mkdir(sourceRoot, { recursive: true });
    await cp(join(workspace, "packages/core/src"), join(sourceRoot, "src"), { recursive: true });
    await cp(join(workspace, "packages/core/test"), join(sourceRoot, "test"), { recursive: true });
    const relativeFile = relative("packages/core", mutant.file);
    const target = join(sourceRoot, relativeFile);
    const original = await readFile(target, "utf8");
    await writeFile(target, replaceOccurrence(original, mutant.search, mutant.replacement, mutant.occurrence), "utf8");
    try {
      await execute(
        join(workspace, "node_modules/.bin/poku"),
        [join(temporary, mutant.test), "--reporter=compact", "--enforce"],
        {
          cwd: workspace,
          env: { ...process.env, NO_COLOR: "1" },
        },
      );
      results.push({ id: mutant.id, status: "survived" });
    } catch (error) {
      results.push({ id: mutant.id, status: "killed", exitCode: error.code ?? null });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const killed = results.filter(({ status }) => status === "killed").length;
const report = {
  formatVersion: 1,
  baseline: "mutation-baseline.json",
  total: results.length,
  killed,
  survived: results.length - killed,
  killRatio: results.length === 0 ? 0 : killed / results.length,
  results,
};
if (reportFile !== undefined) {
  await mkdir(resolve(reportFile, ".."), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
if (report.killRatio < baseline.minimumKillRatio) process.exitCode = 1;
