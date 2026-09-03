import type { GrammarFeatureLedger } from "./feature-ledger.js";

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function ranges(ledger: GrammarFeatureLedger, dialect: string, kind: "stable" | "canary"): string {
  const selected = ledger.dialects[dialect]?.[kind] ?? [];
  if (selected.length === 0) return "None";
  return selected.map(({ minimum, maximum }) => (minimum === maximum ? minimum : `${minimum}–${maximum}`)).join(", ");
}

function supportCell(ledger: GrammarFeatureLedger, featureId: string, dialect: string): string {
  const support = ledger.entries.find(({ id }) => id === featureId)?.dialects[dialect];
  if (support === undefined) return "unclassified";
  const version = [
    support.introduced === undefined ? undefined : `from ${support.introduced}`,
    support.removed === undefined ? undefined : `before ${support.removed}`,
  ]
    .filter((value): value is string => value !== undefined)
    .join(", ");
  return version.length === 0 ? support.level : `${support.level} (${version})`;
}

/** Renders the canonical public support matrix from a validated feature ledger. */
export function renderFeatureLedgerDocumentation(ledger: GrammarFeatureLedger): string {
  const dialects = Object.keys(ledger.dialects);
  const lines = [
    "---",
    "title: Grammar support",
    "description: Version policy and exact, conservative, unsupported, or out-of-scope status for typed-sql grammar features.",
    "---",
    "",
    "# Grammar support",
    "",
    "typed-sql classifies its application-query surface explicitly. `exact` means row types, ordered parameters, diagnostics, and relevant semantics are proven by executable tests. `conservative` means uncertain results remain `unknown`. `unsupported` and `out-of-scope` features fail closed instead of receiving optimistic inference.",
    "",
    "The ranges below describe supported language lines. Exact server patches exercised by release CI are recorded separately from these ranges; an unrecognized future version remains conservative until its behavior is classified.",
    "",
    "## Version policy",
    "",
    "| Grammar | Stable range or lines | Canary range or lines |",
    "| --- | --- | --- |",
    ...dialects.map(
      (dialect) =>
        `| ${escapeCell(ledger.dialects[dialect]!.title)} | ${ranges(ledger, dialect, "stable")} | ${ranges(ledger, dialect, "canary")} |`,
    ),
    "",
    "## Feature classifications",
    "",
    `| Feature | Category | ${dialects.map((dialect) => ledger.dialects[dialect]!.title).join(" | ")} |`,
    `| --- | --- | ${dialects.map(() => "---").join(" | ")} |`,
    ...ledger.entries.map(
      (entry) =>
        `| \`${entry.id}\` — ${escapeCell(entry.title)} | ${entry.category} | ${dialects
          .map((dialect) => escapeCell(supportCell(ledger, entry.id, dialect)))
          .join(" | ")} |`,
    ),
    "",
    "Administrative, replication, maintenance, and procedural command languages are outside the application-query contract. They receive syntax, unsupported, or dynamic-query diagnostics when encountered through static analysis.",
    "",
    "This page is generated from `grammar/features/ledger.json`. Update the ledger, its executable evidence, and this page together.",
    "",
  ];
  return lines.join("\n");
}
