import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { auditInventory, checkReferences, writeAudit } from "./audit.js";
import { builtinAuditConnections } from "./connections/index.js";
import { collectAuditInventory, openAuditConnection } from "./connections/registry.js";
import { builtinAuditGrammars } from "./grammars/index.js";
import { diffInventory, serialize } from "./inventory.mjs";
import { acceptLiveBaseline, recordNativeFindings, reviewLiveBaseline } from "./live-baseline.mjs";
import { recognitionSummary } from "./native.mjs";
import { attachNativeProvenance } from "./provenance.mjs";
import { recognizeLive } from "./recognition.js";
import { directory, refreshReferences } from "./references.js";
import { renderReport } from "./report.js";
import { auditInvocationShapes } from "./shape-audit.js";

const args = process.argv.slice(2);
const valuedOptions = new Set(["--dialect", "--version", "--output", "--baseline", "--before", "--after", "--input"]);
for (let index = 1; index < args.length; index++) {
  const flag = args[index]!;
  if (valuedOptions.has(flag)) {
    if (!args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error(`${flag} needs a value`);
    index++;
  } else if (!["--check", "--require-reviewed"].includes(flag)) throw new Error(`Unknown option ${flag}`);
}
const option = (name: string) => {
  const position = args.indexOf(name);
  if (position < 0) return undefined;
  const value = args[position + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
};
const mode = args[0];
if (mode === "refresh") {
  await refreshReferences();
} else if (mode === "check" || mode === "baseline") {
  await checkReferences(mode === "baseline");
  if (mode === "check") await renderReport(true);
} else if (mode === "report") {
  await renderReport(args.includes("--check"));
} else if (mode === "accept-live") {
  const input = option("--input")!;
  const body = JSON.parse(await readFile(input, "utf8"));
  const captured = body.evidence?.languageInventory ?? body.languageInventory ?? body;
  await acceptLiveBaseline(captured);
  let recognition = body.evidence?.languageRecognition ?? body.languageRecognition;
  if (!recognition) {
    try {
      recognition = JSON.parse(await readFile(`${input}.recognition.json`, "utf8"));
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  }
  await recordNativeFindings(captured, recognition);
  for (const profile of body.profiles ?? [])
    if (profile.languageInventory) {
      await acceptLiveBaseline(profile.languageInventory);
      await recordNativeFindings(profile.languageInventory, profile.languageRecognition);
    }
} else if (mode === "diff") {
  const before = JSON.parse(await readFile(option("--before")!, "utf8"));
  const after = JSON.parse(await readFile(option("--after")!, "utf8"));
  const changes = diffInventory(before, after);
  console.log(JSON.stringify(changes, null, 2));
  if (changes.length) process.exitCode = 1;
} else if (mode === "shapes") {
  const dialect = option("--dialect"),
    output = option("--output");
  if (!dialect || !output) throw new Error("shapes requires --dialect and --output");
  const live = await openAuditConnection(builtinAuditConnections, dialect, {
    ...(option("--version") ? { version: option("--version")! } : {}),
  });
  try {
    const capture = await collectAuditInventory(builtinAuditConnections, dialect, live);
    await attachNativeProvenance(capture);
    const report = await auditInvocationShapes(
      dialect,
      String(live.target.version),
      capture.categories.functions?.rows ?? [],
      live.prepare,
      live.server,
    );
    await mkdir(dirname(resolve(output)), { recursive: true });
    await writeFile(`${output}.inventory.json`, `${serialize(capture)}\n`);
    await writeFile(output, `${serialize(report)}\n`);
    console.log(
      JSON.stringify({
        grammar: dialect,
        version: report.version,
        qualification: report.qualification,
        entities: report.entities.length,
        entitiesWithGaps: report.entities.filter((entity) => entity.gaps.length > 0).length,
        counts: report.counts,
        failures: report.failures,
        uniqueStatements: report.uniqueStatements,
      }),
    );
    if (report.failures)
      throw new Error(`Native invocation shapes expose ${report.failures} invalid typed invocations: ${output}`);
  } finally {
    await live.close();
  }
} else if (mode === "live") {
  const dialect = option("--dialect");
  const output = option("--output");
  if (!dialect || !output) throw new Error("live requires --dialect and --output");
  const live = await openAuditConnection(builtinAuditConnections, dialect, {
    ...(option("--version") ? { version: option("--version")! } : {}),
  });
  try {
    const captured = await collectAuditInventory(builtinAuditConnections, dialect, live);
    await attachNativeProvenance(captured);
    await mkdir(dirname(resolve(output)), { recursive: true });
    await writeFile(output, `${serialize(captured)}\n`);
    await writeAudit([auditInventory(captured)], `${output}.audit.json`);
    const functions = captured.categories.functions;
    const referenceVersion = builtinAuditGrammars.get(dialect).versionBand(String(live.target.version));
    const rows =
      functions?.rows ??
      JSON.parse(await readFile(resolve(directory, `${dialect}-${referenceVersion}.json`), "utf8")).categories.functions
        .rows;
    const recognition = await recognizeLive(dialect, String(live.target.version), rows, live.prepare, live.server);
    await writeFile(`${output}.recognition.json`, `${serialize(recognition)}\n`);
    const complete = { ...captured, recognition: recognitionSummary(recognition) };
    await writeFile(output, `${serialize(complete)}\n`);
    const reviewed = await reviewLiveBaseline(complete);
    await writeFile(`${output}.review.json`, `${JSON.stringify(reviewed, null, 2)}\n`);
    if (reviewed.status === "invalid-inference" || (args.includes("--require-reviewed") && reviewed.status !== "match"))
      throw new Error(`Live inventory requires review: ${output}.review.json`);
    const baseline = option("--baseline");
    if (baseline) {
      const changes = diffInventory(JSON.parse(await readFile(baseline, "utf8")), complete);
      await writeFile(`${output}.diff.json`, `${JSON.stringify(changes, null, 2)}\n`);
      if (changes.length)
        throw new Error(`${changes.length} upstream inventory changes require review: ${output}.diff.json`);
    }
    console.log(`${dialect} ${live.target.version}: live inventory and mapping observations written to ${output}`);
  } finally {
    await live.close();
  }
} else if (mode === "capture-embedded") {
  // Exact engine captures, independent of the grammar's committed builtin lists.
  for (const owner of builtinAuditConnections.ids.map((id) => builtinAuditConnections.get(id))) {
    for (const version of owner.captureTargets ?? []) {
      // Native SDK versions run in separate processes; symbols can otherwise bind to
      // the first engine loaded into the process and falsely qualify a different SDK version.
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/language-audit/run.ts",
          "live",
          "--dialect",
          owner.id,
          "--version",
          version,
          "--output",
          resolve("artifacts/language-audit", `${owner.id}-${version}.json`),
        ],
        {
          stdio: "inherit",
          env: { ...process.env, TSX_TSCONFIG_PATH: resolve("scripts/language-audit/tsconfig.json") },
        },
      );
      await writeFile(
        resolve(directory, `${owner.id}-${version}.json`),
        await readFile(resolve("artifacts/language-audit", `${owner.id}-${version}.json`), "utf8"),
      );
    }
  }
} else throw new Error("Usage: audit:language refresh|check|baseline|live|shapes|diff|capture-embedded");
