import { history, redo, undo } from "@codemirror/commands";
import { EditorState, type Transaction } from "@codemirror/state";
import { describe, it, strict } from "poku";
import {
  changesEditorLineSeparator,
  editorDocumentExtensions,
  emitsEditorDocumentChange,
  externalDocumentTransaction,
  serializeEditorDocument,
} from "../ui/editor-document.js";

function document(source: string, readOnly = false) {
  let state = EditorState.create({
    doc: source,
    extensions: [history(), editorDocumentExtensions(source), EditorState.readOnly.of(readOnly)],
  });
  const transactions: Transaction[] = [];
  return {
    get state() {
      return state;
    },
    transactions,
    dispatch(transaction: Transaction) {
      transactions.push(transaction);
      state = transaction.state;
    },
  };
}
function external(editor: ReturnType<typeof document>, source: string) {
  const spec = externalDocumentTransaction(editor.state, source);
  if (!spec) throw new Error("Expected an external source change");
  const transaction = editor.state.update(spec);
  editor.dispatch(transaction);
  return transaction;
}
await describe("editor source serialization and undo", async () => {
  await it("keeps original CRLF when typing and keeps the normalized model for displayed coordinates", () => {
    const source = "const query = sql`select 'first\r\nsecond'`;\r\n";
    const editor = document(source);
    strict.equal(editor.state.doc.toString(), source.replaceAll("\r\n", "\n"));
    strict.equal(serializeEditorDocument(editor.state), source);
    const typed = editor.state.update({
      changes: { from: editor.state.doc.length, insert: "// note\n" },
      userEvent: "input.type",
    });
    editor.dispatch(typed);
    strict.equal(emitsEditorDocumentChange(typed), true);
    strict.equal(changesEditorLineSeparator(typed), false);
    strict.equal(serializeEditorDocument(editor.state), `${source}// note\r\n`);
    strict.equal(editor.state.lineBreak, "\n", "Native insertion/completion parsing stays newline agnostic");
  });
  await it("undoes text formatting and EOL preference as one event without external sync callbacks", () => {
    const original = "const value={id:1};\n";
    const formatted = "const value = { id: 1 };\r\n";
    const editor = document(original);
    const sync = external(editor, formatted);
    strict.equal(emitsEditorDocumentChange(sync), false);
    strict.equal(serializeEditorDocument(editor.state), formatted);
    strict.equal(undo(editor), true);
    strict.equal(serializeEditorDocument(editor.state), original);
    strict.equal(emitsEditorDocumentChange(editor.transactions.at(-1)!), true);
    strict.equal(redo(editor), true);
    strict.equal(serializeEditorDocument(editor.state), formatted);
  });
  await it("preserves newline preference when user edits temporarily leave a single line", () => {
    const editor = document("first\r\n");
    editor.dispatch(editor.state.update({ changes: { from: 5, to: editor.state.doc.length } }));
    strict.equal(serializeEditorDocument(editor.state), "first");
    strict.equal(externalDocumentTransaction(editor.state, "first"), undefined);
    editor.dispatch(editor.state.update({ changes: { from: 5, insert: "\nnext" } }));
    strict.equal(serializeEditorDocument(editor.state), "first\r\nnext");
  });
  await it("makes EOL-only formatting undoable while read-only sync never emits source edits", () => {
    const editor = document("one\ntwo\n");
    const sync = external(editor, "one\r\ntwo\r\n");
    strict.equal(sync.docChanged, false);
    strict.equal(changesEditorLineSeparator(sync), true, "EOL-only format invalidates semantic requests");
    strict.equal(emitsEditorDocumentChange(sync), false);
    strict.equal(serializeEditorDocument(editor.state), "one\r\ntwo\r\n");
    strict.equal(undo(editor), true);
    strict.equal(serializeEditorDocument(editor.state), "one\ntwo\n");
    strict.equal(emitsEditorDocumentChange(editor.transactions.at(-1)!), true);
    const readonly = document("original\r\n", true);
    strict.equal(emitsEditorDocumentChange(external(readonly, "updated\n")), false);
    const forced = readonly.state.update({ changes: { from: 0, insert: "ignored" } });
    strict.equal(emitsEditorDocumentChange(forced), false);
  });
});
