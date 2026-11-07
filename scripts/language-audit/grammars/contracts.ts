import type { DialectAnalysis, DialectServerEvidence } from "../../../packages/core/src/index.js";
import type { InvocationShapeSyntax } from "../invocation-shapes.js";
import type { DiscoveredFunction } from "../invocations.js";

export interface AuditableGrammar {
  names: ReadonlySet<string>;
  analyze(sql: string): Pick<DialectAnalysis, "columns" | "parameters" | "diagnostics">;
}

export interface AuditGrammar {
  id: string;
  versionBand(version: string): string;
  createAnalysis(version: string, server?: DialectServerEvidence): AuditableGrammar;
  tokenize(sql: string): readonly { kind: string }[];
  planInvocations(row: DiscoveredFunction): string[];
  invocationShapeSyntax?: InvocationShapeSyntax;
  planEntity(category: string, name: string): string | undefined;
}

export type AuditGrammarDefinition = { id: string; extends?: string } & Partial<Omit<AuditGrammar, "id">>;
