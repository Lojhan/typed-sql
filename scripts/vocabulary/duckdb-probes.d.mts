export interface DuckDBVocabularyAuditConnection {
  runAndReadAll(sql: string): Promise<{ getRowObjects(): Record<string, unknown>[] }>;
  prepare(sql: string): Promise<{ destroySync(): void }>;
}

export function assertDuckDBVocabulary(
  connection: DuckDBVocabularyAuditConnection,
  version: string,
): Promise<{ version: string; declarations: number; nativeRecords: number; probes: number }>;
