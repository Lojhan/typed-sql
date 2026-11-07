import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { DialectServerEvidence } from "../../packages/core/src/index.js";
import { builtinAuditGrammars } from "./grammars/index.js";
import type { AuditGrammarRegistry } from "./grammars/registry.js";
import { CATEGORIES, hash, serialize } from "./inventory.mjs";
import { directory, loadReferences } from "./references.js";

export type FunctionRow = { name: string; kind?: string; arity?: number; arguments?: unknown; result?: unknown };
type Observation = { name: string; status: string; example?: string; diagnostics?: string[] };
type CategoryObservation = {
  status: string;
  reason?: string;
  fingerprint?: string;
  count?: number;
  observations?: Observation[];
};

export function grammarFor(
  dialect: string,
  version: string,
  actualServer?: DialectServerEvidence,
  registry: AuditGrammarRegistry = builtinAuditGrammars,
) {
  const mapper = registry.get(dialect);
  const grammar = mapper.createAnalysis(mapper.versionBand(version), actualServer);
  return {
    ...grammar,
    tokenize: mapper.tokenize,
    planInvocations: mapper.planInvocations,
    planEntity: mapper.planEntity,
  };
}

// These are recognition probes, not an oracle for valid overloads, nullability, or runtime decoding.
// Typed arguments / domain constraints cannot safely be invented from a name-only manual inventory.
export function auditFunctions(rows: FunctionRow[], grammar: ReturnType<typeof grammarFor>): Observation[] {
  return [...new Set(rows.map((row) => row.name.toLowerCase()))].sort().map((name) => {
    if (!/^[a-z_][a-z_0-9]*$/u.test(name)) return { name, status: "special-syntax-unverified" };
    if (grammar.names.has(name)) return { name, status: "declared-semantics-unverified" };
    let unknown: { example: string; diagnostics: string[] } | undefined;
    for (const example of grammar.planInvocations({ name })) {
      const result = grammar.analyze(example);
      const diagnostics = result.diagnostics.map((row) => `${row.code}: ${row.message}`);
      if (
        result.diagnostics.length === 0 &&
        result.columns.length > 0 &&
        result.columns.every((column) => column.tsType !== "unknown" && column.tsType !== "any")
      )
        return { name, status: "typed-recognition-semantics-unverified", example };
      if (
        diagnostics.some((message) => /unknown\s+(?:(?:or ambiguous|qualified)\s+)?(?:\w+\s+)?function/iu.test(message))
      )
        unknown = { example, diagnostics };
    }
    return unknown
      ? { name, status: "unknown-function-observed", ...unknown }
      : { name, status: "invocation-unverified" };
  });
}

export function auditInventory(
  input: {
    dialect: string;
    target: { version: string };
    categories: Record<string, { status: string; rows?: FunctionRow[]; reason?: string; fingerprint?: string }>;
  },
  registry: AuditGrammarRegistry = builtinAuditGrammars,
) {
  const grammar = grammarFor(input.dialect, input.target.version, undefined, registry);
  const categories: Record<string, CategoryObservation> = Object.fromEntries(
    CATEGORIES.map((category) => {
      const source = input.categories[category];
      if (source?.status !== "observed")
        return [
          category,
          {
            status: "unavailable",
            reason: source?.reason ?? "Not provided by this reference inventory; consult live evidence.",
          },
        ];
      if (!source.rows?.length || hash(source.rows) !== source.fingerprint)
        throw new Error(`Invalid ${input.dialect} ${category} inventory fingerprint`);
      return [
        category,
        {
          status: "observed",
          fingerprint: source.fingerprint,
          count: source.rows!.length,
          observations:
            category === "functions"
              ? auditFunctions(source.rows!, grammar)
              : auditOther(category, source.rows!, grammar),
        },
      ];
    }),
  );
  return { dialect: input.dialect, target: input.target, categories };
}

function auditOther(category: string, rows: FunctionRow[], grammar: ReturnType<typeof grammarFor>): Observation[] {
  return [...new Set(rows.map((row) => row.name))].sort().map((name) => {
    if (category === "keywords" && /^[a-z_]+$/iu.test(name)) {
      const token = grammar.tokenize(name)[0];
      return {
        name,
        status: token?.kind === "keyword" ? "keyword-token-observed" : "contextual-or-unclassified-keyword",
      };
    }
    const example = grammar.planEntity(category, name);
    if (!example) return { name, status: "semantics-unverified" };
    const result = grammar.analyze(example);
    if (
      result.diagnostics.length === 0 &&
      result.columns.length > 0 &&
      result.columns.every((column) => column.tsType !== "unknown" && column.tsType !== "any")
    )
      return { name, status: "typed-recognition-semantics-unverified", example };
    return {
      name,
      status: "invocation-unverified",
      example,
      diagnostics: result.diagnostics.map((row) => `${row.code}: ${row.message}`),
    };
  });
}

export async function writeAudit(reports: ReturnType<typeof auditInventory>[], output: string) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({ formatVersion: 1, reports }, null, 2)}\n`);
}

export async function checkReferences(write = false) {
  const reports = (await loadReferences()).map((input) => auditInventory(input));
  const baseline = resolve(directory, "baseline.json");
  const summary = reports.map((report) => ({
    ...report,
    categories: Object.fromEntries(
      Object.entries(report.categories).map(([category, evidence]) => [
        category,
        {
          ...evidence,
          ...(evidence.observations
            ? { observations: evidence.observations.map(({ name, status }: Observation) => ({ name, status })) }
            : {}),
        },
      ]),
    ),
  }));
  const value = `${serialize({ formatVersion: 1, fingerprint: hash(summary), reports: summary })}\n`;
  if (write) await writeFile(baseline, value);
  else if ((await readFile(baseline, "utf8")) !== value)
    throw new Error(
      "Language audit changed. Generate and review the complete report with pnpm audit:language:baseline; do not silently accept new gaps.",
    );
  console.log(`${reports.length} upstream reference targets audited; semantics-unverified is not a support claim.`);
  return reports;
}
