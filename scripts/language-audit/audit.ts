import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { DialectServerEvidence } from "../../packages/core/src/index.js";
import { duckdb } from "../../packages/duckdb/src/analysis.js";
import { duckDBBuiltinCatalog } from "../../packages/duckdb/src/catalog/index.js";
import { tokenize as tokenizeDuckDB } from "../../packages/duckdb/src/parser/tokenizer.js";
import { duckDBServerEvidence } from "../../packages/duckdb/src/support.js";
import { mysql } from "../../packages/mysql/src/analysis.js";
import { mySqlServerEvidence } from "../../packages/mysql/src/capabilities.js";
import { mySqlCoreCatalog } from "../../packages/mysql/src/catalog/index.js";
import { tokenize as tokenizeMySql } from "../../packages/mysql/src/parser/tokenizer.js";
import { postgres } from "../../packages/postgres/src/analysis.js";
import { postgresServerEvidence } from "../../packages/postgres/src/capabilities.js";
import { postgresCoreCatalog } from "../../packages/postgres/src/catalog/index.js";
import { tokenize as tokenizePostgres } from "../../packages/postgres/src/parser/tokenizer.js";
import { postgresVocabulary } from "../../packages/postgres/src/vocabulary/index.js";
import { sqlite } from "../../packages/sqlite/src/analysis.js";
import { SQLITE_BUILTIN_FUNCTIONS } from "../../packages/sqlite/src/catalog/functions.js";
import { SQLITE_JSON_TABLE_FUNCTIONS } from "../../packages/sqlite/src/catalog/json.js";
import { tokenize as tokenizeSqlite } from "../../packages/sqlite/src/parser/tokenizer.js";
import { sqlserver } from "../../packages/sqlserver/src/analysis.js";
import { sqlServerServerEvidence } from "../../packages/sqlserver/src/capabilities.js";
import { SQLSERVER_BUILTINS } from "../../packages/sqlserver/src/catalog/index.js";
import { tokenize as tokenizeSqlServer } from "../../packages/sqlserver/src/parser/tokenizer.js";
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

export function grammarFor(dialect: string, version: string, actualServer?: DialectServerEvidence) {
  const base = { formatVersion: 1 as const, tables: {}, functions: {} };
  if (dialect === "postgres") {
    const major = Number.parseInt(version, 10);
    const server = postgresServerEvidence(`${major}.0`, [], { standardConformingStrings: "on", searchPath: "public" });
    const grammar = postgres({ versionPolicy: major === 19 ? "canary" : "stable" });
    const catalog = postgresCoreCatalog(major);
    if (!catalog) throw new Error(`Unsupported PostgreSQL catalog ${version}`);
    return {
      names: new Set(
        [...catalog.routines, ...catalog.tableRoutines].flatMap((family) =>
          family.routines.map((name) => name.toLowerCase()),
        ),
      ),
      analyze: (sql: string) => grammar.analyze(sql, { ...base, dialect: "postgres", server: actualServer ?? server }),
    };
  }
  if (dialect === "mysql") {
    const catalog = mySqlCoreCatalog(version);
    if (!catalog) throw new Error(`Unsupported MySQL catalog ${version}`);
    const server = mySqlServerEvidence(`${version}.0`, { versionComment: "MySQL Community Server - GPL", sqlMode: "" });
    const grammar = mysql({ versionPolicy: version === "26.7" ? "canary" : "stable" });
    return {
      names: new Set(catalog.routines.flatMap((family) => family.routines.map((name) => name.toLowerCase()))),
      analyze: (sql: string) => grammar.analyze(sql, { ...base, dialect: "mysql", server: actualServer ?? server }),
    };
  }
  if (dialect === "sqlite") {
    const actual = version.replace(/^reference-/u, "");
    const server = {
      product: "sqlite",
      version: actual,
      versionKey: actual,
      features: ["ENABLE_MATH_FUNCTIONS"],
      settings: {},
    };
    const grammar = sqlite();
    return {
      names: new Set(
        [...SQLITE_BUILTIN_FUNCTIONS.filter((row) => row.resolvable !== false), ...SQLITE_JSON_TABLE_FUNCTIONS]
          .filter(
            (row) => !row.availableSince || actual.localeCompare(row.availableSince, undefined, { numeric: true }) >= 0,
          )
          .map((row) => row.name.toLowerCase()),
      ),
      analyze: (sql: string) =>
        grammar.analyze(sql, { ...base, dialect: "sqlite", version: actual, server: actualServer ?? server }),
    };
  }
  if (dialect === "sqlserver") {
    const major = Number.parseInt(version, 10);
    const server = sqlServerServerEvidence(`${major}.0.0.0`, {
      compatibilityLevel: major * 10,
      collation: "Latin1_General_100_CI_AS",
      defaultSchema: "dbo",
      quotedIdentifier: true,
      ansiWarnings: true,
      arithAbort: true,
      concatNullYieldsNull: true,
      dateFirst: 7,
      dateFormat: "mdy",
      language: "us_english",
    });
    const grammar = sqlserver();
    return {
      names: new Set(
        Object.values(SQLSERVER_BUILTINS)
          .filter((row) => !row.since || major >= row.since)
          .map((row) => row.name.toLowerCase()),
      ),
      analyze: (sql: string) => grammar.analyze(sql, { ...base, dialect: "sqlserver", server: actualServer ?? server }),
    };
  }
  if (dialect === "duckdb") {
    const grammar = duckdb();
    const server = duckDBServerEvidence(version, [], {
      Calendar: "gregorian",
      integer_division: "false",
      preserve_identifier_case: version === "1.5.6" ? "true" : "preserve_case",
      ...(version === "1.5.6" ? { old_implicit_casting: "false" } : {}),
    });
    return {
      names: new Set(duckDBBuiltinCatalog(version).map((row) => row[0].toLowerCase())),
      analyze: (sql: string) => grammar.analyze(sql, { ...base, dialect: "duckdb", server: actualServer ?? server }),
    };
  }
  throw new Error(`Unknown grammar ${dialect}`);
}

// These are recognition probes, not an oracle for valid overloads, nullability, or runtime decoding.
// Typed arguments / domain constraints cannot safely be invented from a name-only manual inventory.
export function auditFunctions(rows: FunctionRow[], grammar: ReturnType<typeof grammarFor>): Observation[] {
  return [...new Set(rows.map((row) => row.name.toLowerCase()))].sort().map((name) => {
    if (!/^[a-z_][a-z_0-9]*$/u.test(name)) return { name, status: "special-syntax-unverified" };
    if (grammar.names.has(name)) return { name, status: "declared-semantics-unverified" };
    let unknown: { example: string; diagnostics: string[] } | undefined;
    for (const count of [0, 1, 2, 3, 4, 5]) {
      const call = `${name}(${Array(count).fill("NULL").join(", ")})`;
      const example = `SELECT ${call} AS value`;
      const result = grammar.analyze(example);
      const diagnostics = result.diagnostics.map((row) => `${row.code}: ${row.message}`);
      if (
        result.diagnostics.length === 0 &&
        result.columns.length > 0 &&
        result.columns.every((column) => column.tsType !== "unknown" && column.tsType !== "any")
      )
        return { name, status: "typed-recognition-semantics-unverified", example };
      if (
        result.diagnostics.some((row) => row.code === "TSQ408") ||
        diagnostics.some((message) => /unknown\s+(?:(?:or ambiguous|qualified)\s+)?(?:\w+\s+)?function/iu.test(message))
      )
        unknown = { example, diagnostics };
    }
    return unknown
      ? { name, status: "unknown-function-observed", ...unknown }
      : { name, status: "invocation-unverified" };
  });
}

export function auditInventory(input: {
  dialect: string;
  target: { version: string };
  categories: Record<string, { status: string; rows?: FunctionRow[]; reason?: string; fingerprint?: string }>;
}) {
  const grammar = grammarFor(
    input.dialect,
    input.dialect === "mysql"
      ? input.target.version.split(".").slice(0, 2).join(".")
      : input.dialect === "postgres" || input.dialect === "sqlserver"
        ? input.target.version.split(".")[0]!
        : input.target.version,
  );
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
              : auditOther(category, source.rows!, grammar, input.dialect, input.target.version),
        },
      ];
    }),
  );
  return { dialect: input.dialect, target: input.target, categories };
}

function auditOther(
  category: string,
  rows: FunctionRow[],
  grammar: ReturnType<typeof grammarFor>,
  dialect: string,
  version: string,
): Observation[] {
  const tokenize = {
    postgres: tokenizePostgres,
    mysql: tokenizeMySql,
    sqlite: tokenizeSqlite,
    duckdb: tokenizeDuckDB,
    sqlserver: tokenizeSqlServer,
  }[dialect];
  return [...new Set(rows.map((row) => row.name))].sort().map((name) => {
    if (category === "keywords" && /^[a-z_]+$/iu.test(name)) {
      if (dialect === "postgres") {
        const keywordLookup = postgresVocabulary(Number.parseInt(version, 10))?.lookup;
        const token = tokenizePostgres(name, keywordLookup === undefined ? {} : { keywordLookup })[0];
        return {
          name,
          status: token?.nativeKeyword
            ? `keyword-${token.nativeKeyword.category.toLowerCase().replace("_keyword", "")}-observed`
            : "contextual-or-unclassified-keyword",
        };
      }
      const token = tokenize!(name)[0];
      return {
        name,
        status: token?.kind === "keyword" ? "keyword-token-observed" : "contextual-or-unclassified-keyword",
      };
    }
    let example: string | undefined;
    if (category === "types" && /^[a-z_][a-z_0-9 ]*$/iu.test(name)) example = `SELECT CAST(NULL AS ${name}) AS value`;
    if (category === "operators" && /^[~!@#%^&|*+=<>/?-]+$/u.test(name)) example = `SELECT NULL ${name} NULL AS value`;
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
  const reports = (await loadReferences()).map(auditInventory);
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
