import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderFeatureLedgerDocumentation } from "../packages/conformance/src/feature-ledger-markdown.js";
import { type GrammarFeatureLedger, parseGrammarFeatureLedger } from "../packages/conformance/src/index.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ledgerPath = resolve(workspace, "grammar/features/ledger.json");
const documentationPath = resolve(workspace, "docs/reference/grammar-support.md");

export function featureLedgerSummary(ledger: GrammarFeatureLedger): string {
  const counts = new Map<string, number>();
  for (const entry of ledger.entries) {
    for (const [dialect, support] of Object.entries(entry.dialects)) {
      const key = `${dialect}.${support.level}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [
    `Feature ledger v${ledger.formatVersion}: ${ledger.entries.length} entries, ${Object.keys(ledger.dialects).length} grammars`,
    ...[...counts].sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => `  ${key}: ${count}`),
  ].join("\n");
}

async function loadLedger(): Promise<GrammarFeatureLedger> {
  return parseGrammarFeatureLedger(JSON.parse(await readFile(ledgerPath, "utf8")) as unknown);
}

async function main(): Promise<void> {
  const ledger = await loadLedger();
  const rendered = renderFeatureLedgerDocumentation(ledger);
  if (process.argv.includes("--write")) {
    await writeFile(documentationPath, rendered, "utf8");
  } else if (process.argv.includes("--check")) {
    const current = await readFile(documentationPath, "utf8");
    if (current !== rendered) throw new Error("docs/reference/grammar-support.md is stale; run pnpm grammar:docs");
  } else if (process.argv.includes("--print")) {
    process.stdout.write(rendered);
    return;
  }
  process.stdout.write(`${featureLedgerSummary(ledger)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
