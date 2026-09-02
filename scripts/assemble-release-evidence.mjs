import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleReleaseEvidence,
  loadEvidenceInput,
  validateReleaseExceptions,
  writeImmutableEvidence,
} from "./release-evidence.mjs";
import { loadReleaseEvidencePolicy } from "./release-evidence-policy.mjs";
import { loadReleaseManifest } from "./release-policy.mjs";

const workspace = resolve(import.meta.dirname, "..");

function values(arguments_, flag) {
  return arguments_.flatMap((argument, index) => (argument === flag ? [arguments_[index + 1]] : [])).filter(Boolean);
}

function value(arguments_, flag, fallback) {
  const found = values(arguments_, flag);
  if (found.length > 1) throw new TypeError(`${flag} may be specified only once`);
  return found[0] ?? fallback;
}

export async function main(arguments_ = process.argv.slice(2)) {
  const exceptionsPath = resolve(workspace, value(arguments_, "--exceptions", "release-exceptions.json"));
  const exceptions = validateReleaseExceptions(JSON.parse(await readFile(exceptionsPath, "utf8")));
  if (arguments_.includes("--check-exceptions")) {
    process.stdout.write(`Validated ${exceptions.exceptions.length} active release exception(s)\n`);
    return;
  }
  const outputValue = value(arguments_, "--output");
  const revision = value(arguments_, "--revision", process.env.GITHUB_SHA ?? "local");
  const inputPaths = values(arguments_, "--input");
  if (outputValue === undefined || inputPaths.length === 0) {
    throw new TypeError("Usage: assemble-release-evidence --output <path> --input <path> [--input <path>]");
  }
  const [policy, manifest, inputs] = await Promise.all([
    loadReleaseEvidencePolicy(workspace),
    loadReleaseManifest(workspace),
    Promise.all(inputPaths.map((path) => loadEvidenceInput(resolve(workspace, path)))),
  ]);
  const report = assembleReleaseEvidence({ policy, manifest, exceptions, inputs, revision });
  if (!report.publishable)
    throw new Error(`Release evidence is missing unexcepted gates: ${report.blocking.join(", ")}`);
  if (arguments_.includes("--require-complete") && !report.complete) {
    throw new Error(
      `Complete release evidence is required; excepted gates remain missing: ${report.excepted.join(", ")}`,
    );
  }
  const output = resolve(workspace, outputValue);
  await mkdir(dirname(output), { recursive: true });
  await writeImmutableEvidence(output, report);
  process.stdout.write(
    `${manifest.channel} evidence: ${report.proven.length}/${report.required.length} required gates proven\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
