import { describe, it, strict } from "poku";
import {
  analysisKey,
  clearDocumentAnalysis,
  currentRunDocument,
  movedDocument,
  pendingRunFiles,
  schemaEpoch,
  type WorkspaceDocument,
} from "../ui/document-state.js";

const document = (file: string, source = "export const id=1;", saved = source): WorkspaceDocument => ({
  file,
  source,
  saved,
  revision: "saved-revision",
  writable: true,
  mode: file.endsWith(".sql") ? "sql" : "export",
  exportName: "run",
  readOnly: true,
  parameters: {},
  analysis: { revision: "analysis", queries: [], exports: [], diagnostics: [] },
  languageSource: source,
  languageEpoch: "old-schema",
  languageDiagnostics: [],
});
await describe("editor source and schema identities", async () => {
  await it("blocks unsaved project imports by filename while independent raw SQL remains runnable", () => {
    const entry = document("playground/query.ts"),
      helper = document("playground/helper.ts", "export const id=2;"),
      sql = document("playground/query.sql", "select 2;", "select 1;");
    helper.saved = "export const id=1;";
    strict.deepEqual(pendingRunFiles({ entry, helper, sql }, entry.file, "export"), [helper.file, sql.file]);
    strict.deepEqual(pendingRunFiles({ entry, helper, sql }, sql.file, "sql"), []);
    strict.deepEqual(
      pendingRunFiles(
        { entry, helper: { ...helper, source: helper.saved }, sql: { ...sql, definition: true } },
        entry.file,
        "export",
      ),
      [],
    );
  });
  await it("rejects results from an earlier source, revision, schema or type-policy generation", () => {
    const captured = document("query.ts"),
      epoch = schemaEpoch({ schemaHash: "one", typePolicyHash: "policy" }),
      identity = analysisKey(captured, epoch);
    strict.notEqual(analysisKey({ ...captured, source: "changed" }, epoch), identity);
    strict.notEqual(analysisKey({ ...captured, revision: "reloaded" }, epoch), identity);
    strict.notEqual(analysisKey(captured, schemaEpoch({ schemaHash: "two", typePolicyHash: "policy" })), identity);
    strict.notEqual(analysisKey(captured, schemaEpoch({ schemaHash: "one", typePolicyHash: "policy-two" })), identity);
    strict.equal(currentRunDocument(captured, captured, "fresh-save"), true);
    strict.equal(currentRunDocument({ ...captured, revision: "fresh-save" }, captured, "fresh-save"), true);
    strict.equal(currentRunDocument({ ...captured, source: "edited while checking" }, captured, "fresh-save"), false);
    strict.equal(currentRunDocument({ ...captured, revision: "external-change" }, captured, "fresh-save"), false);
    strict.equal(currentRunDocument(undefined, captured, "fresh-save"), false);
  });
  await it("invalidates cached host/native analysis without changing editable source", () => {
    const previous = document("query.ts"),
      next = clearDocumentAnalysis(previous);
    strict.equal(next.source, previous.source);
    strict.equal(next.revision, previous.revision);
    strict.equal(next.analysis, undefined);
    strict.equal(next.languageDiagnostics, undefined);
    strict.equal(next.languageSource, undefined);
    strict.equal(next.languageEpoch, undefined);
    strict.ok(previous.analysis);
  });
  await it("renames against the actual moved revision and retains concurrent unsaved edits", () => {
    const previous = document("query.ts", "new edit", "saved before move"),
      next = movedDocument(previous, "renamed.ts", "moved-content-hash", "content captured by save");
    strict.equal(next.file, "renamed.ts");
    strict.equal(next.revision, "moved-content-hash");
    strict.equal(next.source, "new edit");
    strict.equal(next.saved, "content captured by save");
    strict.notEqual(next.source, next.saved);
    strict.equal(next.analysis, undefined);
    strict.equal(previous.file, "query.ts");
    strict.equal(movedDocument(previous, "query.sql", "rev", previous.source).mode, "sql");
    strict.equal(movedDocument(document("query.sql"), "query.ts", "rev", "saved").mode, "export");
  });
});
