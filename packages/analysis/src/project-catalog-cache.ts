import type { AnalysisCacheToken } from "./cache.js";
import { canonicalContractData, exactSqlDigest, queryContractDigest } from "./canonical.js";
import { type AnalysisContextScope, analysisContextScopeKey, parseAnalysisContextScope } from "./context-scope.js";
import type { ProjectCatalogClosure } from "./project-catalog.js";

export interface ProjectCatalogCacheQuery {
  readonly scope: AnalysisContextScope;
  /** Selection inputs are transient; only their exact digests are indexed. */
  readonly sql: readonly string[];
}
export interface ProjectCatalogCacheLookup {
  readonly token: AnalysisCacheToken;
  readonly blocked?: "stale-context";
  readonly cached?: {
    readonly closure: ProjectCatalogClosure;
    readonly recordedAt: number;
    readonly freshness: "unverified";
  };
}
/** Namespace selection independently of query-result evidence and never store SQL source. */
export function projectCatalogCacheSelection(input: ProjectCatalogCacheQuery) {
  const value = JSON.parse(canonicalContractData(input));
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "scope,sql")
    throw new TypeError("Invalid project catalog cache selection");
  const scope = parseAnalysisContextScope(value.scope);
  if (
    !Array.isArray(value.sql) ||
    value.sql.length > 4096 ||
    value.sql.some((sql: unknown) => typeof sql !== "string" || !sql.length)
  )
    throw new TypeError("Invalid project catalog query selection");
  const scopeHash = analysisContextScopeKey(scope);
  const queries = [...new Set(value.sql.map((sql: string) => exactSqlDigest(sql)))].sort();
  return {
    scope,
    scopeHash,
    requestKey: queryContractDigest({ kind: "project-catalog-selection-v1", scopeHash, queries }),
  };
}
