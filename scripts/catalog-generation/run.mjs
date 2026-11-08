import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { builtinGenerators } from "../../tools/grammar-catalog/src/generate/index.mjs";
import { importCaptureFiles, readCorpus, verifyCaptureInput } from "./corpus.mjs";
import { generateCatalogs } from "./generate.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

export async function runCatalogCommand(mode, paths = []) {
  if (mode === "check-input") {
    if (!paths.length) throw new Error("catalog:check-input requires native capture paths");
    const corpus = await readCorpus();
    for (const path of paths) {
      const body = JSON.parse(await readFile(path, "utf8"));
      const captures = [
        body.evidence?.languageInventory ?? body.languageInventory ?? body,
        ...(body.profiles ?? []).flatMap((profile) => (profile.languageInventory ? [profile.languageInventory] : [])),
      ];
      for (const capture of captures) {
        const result = await verifyCaptureInput(capture, corpus);
        if (result.status !== "match")
          throw new Error(`Generation input disagrees with native capture ${path}: ${JSON.stringify(result)}`);
      }
    }
  } else if (mode === "import") {
    if (!paths.length) throw new Error("catalog:import requires reviewed capture paths");
    const corpus = await importCaptureFiles(paths);
    console.log(`${Object.keys(corpus.targets).length} reviewed native contexts retained`);
  } else if (mode === "generate" || mode === "check" || mode === "materialize") {
    if (paths.length) throw new Error("Unexpected catalog generation options");
    const ledger = JSON.parse(await readFile(resolve(root, "grammar/features/ledger.json"), "utf8"));
    const requiredTargets = [];
    for (const [dialect, policy] of Object.entries(ledger.dialects)) {
      builtinGenerators.get(dialect);
      const versions = new Set([...policy.stable, ...policy.canary].flatMap((range) => [range.minimum, range.maximum]));
      for (const version of versions) requiredTargets.push({ dialect, version });
    }
    const result = await generateCatalogs(await readCorpus(), {
      check: mode !== "generate",
      materialize: mode === "materialize",
      requiredTargets,
    });
    console.log(
      `${result.groups.length} native version bands; ${result.changed.length} generated files ${mode === "check" ? "stale" : mode === "materialize" ? "materialized" : "updated"}; ${result.retired.length} retired`,
    );
  } else
    throw new Error("Usage: catalog:generate|catalog:check|catalog:materialize|catalog:import|catalog:check-input");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await runCatalogCommand(process.argv[2], process.argv.slice(3));
