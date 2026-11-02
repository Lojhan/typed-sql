import type { CompletionEntryData } from "@typed-sql/browser-typescript";
import type { PlaygroundDialect } from "./playground.js";
import type { WorkspaceFiles } from "./workspace.js";

export interface EditorLocation {
  file: string;
  from: number;
  to: number;
}
export interface EditorTextEdit {
  from: number;
  to: number;
  insert: string;
}
export interface EditorCompletion {
  name: string;
  kind: string;
  sortText: string;
  source?: string;
  insertText?: string;
  replacement?: { from: number; to: number };
  data?: CompletionEntryData;
  grammarImport?: true;
}
export type EditorRequest =
  | { kind: "definition"; file: string; position: number }
  | { kind: "completions"; file: string; position: number }
  | { kind: "completionEdits"; file: string; position: number; entry: EditorCompletion };
type WithoutFile<T> = T extends unknown ? Omit<T, "file"> : never;
export type EditorAction = WithoutFile<EditorRequest>;
export interface EditorRequestEnvelope {
  id: number;
  request: EditorRequest;
  dialect: PlaygroundDialect;
  files: WorkspaceFiles;
}
export interface EditorCompletionEdits {
  edits: EditorTextEdit[];
  detail: string;
}
export type EditorResponse = EditorLocation | EditorCompletion[] | EditorCompletionEdits | undefined;
