import { readFile } from "node:fs/promises";
import { parseDuckDBType } from "../../packages/duckdb/src/native-types.js";
import { SQLITE_LANGUAGE_SUPPORT } from "../../packages/sqlite/src/support.js";
import { liveDuckDBTargets, loadReferences, referenceTargets } from "../language-audit/references.js";
import { importCaptureFiles, readCorpus, verifyCaptureInput } from "./corpus.mjs";
import { generateCatalogs } from "./generate.mjs";

const [mode, ...paths] = process.argv.slice(2);
if (mode === "check-input") {
  if (!paths.length) throw new Error("catalog:check-input requires native capture paths");
  const corpus = await readCorpus();
  for (const path of paths) {
    const body = JSON.parse(await readFile(path, "utf8"));
    const captures = [
      body.evidence?.languageInventory ?? body.languageInventory ?? body,
      ...(body.profiles ?? []).flatMap((profile: { languageInventory?: unknown }) =>
        profile.languageInventory ? [profile.languageInventory] : [],
      ),
    ];
    for (const captured of captures) {
      const result = await verifyCaptureInput(captured, corpus);
      if (result.status !== "match")
        throw new Error(`Generation input disagrees with native capture ${path}: ${JSON.stringify(result)}`);
    }
  }
} else if (mode === "import") {
  if (!paths.length) throw new Error("catalog:import requires reviewed capture paths");
  const corpus = await importCaptureFiles(paths);
  console.log(`${Object.keys(corpus.targets).length} reviewed native contexts retained`);
} else if (mode === "generate" || mode === "check") {
  if (paths.length) throw new Error("Unexpected catalog generation options");
  const result = await generateCatalogs(await readCorpus(), {
    check: mode === "check",
    sqliteTypes: (await loadReferences()).find((input) => input.dialect === "sqlite" && input.sources)?.categories.types
      .rows,
    requiredTargets: [
      ...referenceTargets().filter((target) => target.dialect !== "sqlite"),
      ...liveDuckDBTargets.map((version) => ({ dialect: "duckdb", version })),
      ...[SQLITE_LANGUAGE_SUPPORT.minimum, SQLITE_LANGUAGE_SUPPORT.maximum].map((version) => ({
        dialect: "sqlite",
        version,
      })),
    ],
    duckTypeName: (name: string) => {
      const type = parseDuckDBType(name);
      if (type.kind !== "scalar") throw new Error(`Non-scalar native cast endpoint: ${name}`);
      return type.name;
    },
  });
  console.log(
    `${result.groups.length} native version bands; ${result.changed.length} generated files ${mode === "check" ? "stale" : "updated"}`,
  );
} else throw new Error("Usage: catalog:generate|catalog:check|catalog:import");
