import { invertedEffects, isolateHistory } from "@codemirror/commands";
import {
  Annotation,
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { normalizeEditorSource, preferredLineSeparator } from "./editor-language-model.js";

type LineSeparator = "\r\n" | "\r" | "\n";
const setPreferredSeparator = StateEffect.define<LineSeparator>();
const externalSourceSync = Annotation.define<boolean>();
const preferredSeparator = StateField.define<LineSeparator>({
  create: () => "\n",
  update: (value, transaction) => {
    for (const effect of transaction.effects) if (effect.is(setPreferredSeparator)) value = effect.value;
    return value;
  },
});
/** Keep CM's normalized text model while preserving the source's newline serialization in history. */
export function editorDocumentExtensions(source: string): Extension {
  return [
    preferredSeparator.init(() => preferredLineSeparator(source)),
    invertedEffects.of((transaction) =>
      transaction.effects.some((effect) => effect.is(setPreferredSeparator))
        ? [setPreferredSeparator.of(transaction.startState.field(preferredSeparator))]
        : [],
    ),
  ];
}
export function serializeEditorDocument(state: EditorState): string {
  return state.doc.sliceString(0, state.doc.length, state.field(preferredSeparator));
}
export function externalDocumentTransaction(state: EditorState, source: string): TransactionSpec | undefined {
  const normalized = normalizeEditorSource(source);
  const separator = preferredLineSeparator(source, state.field(preferredSeparator));
  const changed = state.doc.toString() !== normalized;
  const eolChanged = state.field(preferredSeparator) !== separator;
  if (!changed && !eolChanged) return undefined;
  return {
    ...(changed ? { changes: { from: 0, to: state.doc.length, insert: normalized } } : {}),
    ...(eolChanged ? { effects: setPreferredSeparator.of(separator) } : {}),
    annotations: [externalSourceSync.of(true), isolateHistory.of("full")],
  };
}
export function emitsEditorDocumentChange(transaction: Transaction): boolean {
  return (
    !transaction.state.readOnly &&
    !transaction.annotation(externalSourceSync) &&
    (transaction.docChanged || transaction.effects.some((effect) => effect.is(setPreferredSeparator)))
  );
}

export function changesEditorLineSeparator(transaction: Transaction): boolean {
  return transaction.effects.some((effect) => effect.is(setPreferredSeparator));
}
