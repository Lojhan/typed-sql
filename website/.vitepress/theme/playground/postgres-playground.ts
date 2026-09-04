import { analyzePlayground, DEFAULT_SCHEMAS, DEFAULT_SOURCES, type PlaygroundResult } from "./playground.js";

export const DEFAULT_PLAYGROUND_SCHEMA = DEFAULT_SCHEMAS.postgres;
export const DEFAULT_PLAYGROUND_SOURCE = DEFAULT_SOURCES.postgres;

export type { PlaygroundDiagnostic, PlaygroundFile, PlaygroundQuery } from "./playground.js";
export type PostgresPlaygroundResult = PlaygroundResult;

export function analyzePostgresPlayground(schemaSource: string, mainSource: string): PlaygroundResult {
  return analyzePlayground("postgres", schemaSource, mainSource);
}
