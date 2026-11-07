import type { LanguageDiagnostic } from "./editor-language-model.js";
import type { Analysis, State } from "./types.js";

export interface WorkspaceDocument {
  file: string;
  source: string;
  saved: string;
  revision: string;
  writable: boolean;
  analysis?: Analysis;
  mode: "sql" | "file" | "export";
  exportName: string;
  readOnly: boolean;
  parameters: Record<number, { value: string; null: boolean }>;
  definition?: boolean;
  languageSource?: string;
  languageEpoch?: string;
  languageDiagnostics?: readonly LanguageDiagnostic[];
}
type SchemaIdentity = Pick<State, "schemaHash" | "typePolicyHash">;
export const schemaEpoch = (state: SchemaIdentity | null | undefined): string =>
  state ? `${state.schemaHash}:${state.typePolicyHash}` : "";
export const analysisKey = (doc: Pick<WorkspaceDocument, "source" | "revision">, epoch: string): string =>
  JSON.stringify([epoch, doc.revision, doc.source]);
export function clearDocumentAnalysis(doc: WorkspaceDocument): WorkspaceDocument {
  const next = { ...doc };
  delete next.analysis;
  delete next.languageDiagnostics;
  delete next.languageSource;
  delete next.languageEpoch;
  return next;
}
/** Raw SQL executes one statement; project modules may import any other open source. */
export function pendingRunFiles(
  documents: Readonly<Record<string, WorkspaceDocument>>,
  entry: string,
  mode: WorkspaceDocument["mode"],
): string[] {
  if (mode === "sql") return [];
  return Object.values(documents)
    .filter((doc) => doc.file !== entry && !doc.definition && doc.source !== doc.saved)
    .map((doc) => doc.file)
    .sort();
}
export function currentRunDocument(
  doc: WorkspaceDocument | undefined,
  captured: WorkspaceDocument,
  savedRevision: string,
): boolean {
  return (
    !!doc && doc.source === captured.source && (doc.revision === captured.revision || doc.revision === savedRevision)
  );
}
/** A move changes saved identity while retaining edits made during its request. */
export function movedDocument(
  current: WorkspaceDocument,
  file: string,
  revision: string,
  saved: string,
): WorkspaceDocument {
  return {
    ...clearDocumentAnalysis(current),
    file,
    revision,
    saved,
    mode: file.endsWith(".sql") ? "sql" : current.mode === "sql" ? "export" : current.mode,
  };
}
