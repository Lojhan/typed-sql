export interface Column {
  name: string;
  databaseType: string;
  tsType: string;
  nullable: boolean;
  primary: boolean;
  unique: boolean;
}
export interface Table {
  id: string;
  name: string;
  namespace: string;
  kind: string;
  columns: Column[];
  constraints: unknown[];
  indexes: unknown[];
}
export interface Edge {
  id: string;
  source: string;
  target: string;
  columns: string[];
  referencedColumns: string[];
  name: string;
  external: boolean;
}
export interface Board {
  capturedRelationships: boolean;
  tables: Table[];
  edges: Edge[];
}
export type Value =
  | null
  | boolean
  | number
  | string
  | { kind: "undefined" }
  | { kind: "bigint" | "date" | "bytes" | "number"; value: string }
  | { kind: "array"; items: Value[] }
  | { kind: "object"; entries: [string, Value][] };
export interface Run {
  id: string;
  file: string;
  sourceRevision: string;
  mode: string;
  target: string | null;
  startedAt: string;
  schemaHash: string | null;
  typePolicyHash: string;
  finishedAt?: string;
  status: string;
  results: { type: "result"; name: string; value: Value; truncated: boolean; provenance: string }[];
  logs: string;
  error?: { code: string; message: string };
}
export interface State {
  protocolVersion: number;
  project: { name: string; config: string; tsconfig: string };
  target: string | null;
  classification: string | null;
  connection: { state: string; identity?: { database: string; server: string; readOnly: boolean }; message?: string };
  trusted: boolean;
  schemaHash: string;
  typePolicyHash: string;
  capturedAt: string;
  schemaSource: string;
  executionSchemaStale: boolean;
  board: Board;
  files: string[];
  scratchDirectory: string;
  grammar: string;
  limits: { maxRows: number; timeoutMs: number };
  runs: Run[];
}
export interface Analysis {
  revision: string;
  diagnostics: { code: string; message: string; severity: string; range: { line: number; column: number } }[];
  queries: {
    rowType: string;
    parameterType: string;
    sql?: string;
    parameterCount?: number;
    parameters?: { index: number; name?: string; tsType: string; nullable: boolean; databaseType?: string }[];
  }[];
  exports: string[];
}
