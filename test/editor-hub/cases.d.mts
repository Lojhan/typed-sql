export interface Variant {
  query: string;
  member: string;
  type: string;
}
export interface GrammarCase {
  id: string;
  packageName: string;
  packageDirectory: string;
  factory: string;
  schema: Record<string, unknown>;
  initial: Variant & { completions: string[] };
  changed: Variant;
  wrongType: string;
  invalidQuery: string;
  diagnosticPattern: string;
  schemaRefresh?: { table: string; column: string; type: string };
}
export const grammarCases: GrammarCase[];
export const interfaces: string[];
export function sourceFor(spec: GrammarCase, variant?: Variant): string;
