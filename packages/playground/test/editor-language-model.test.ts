import { describe, it, strict } from "poku";
import {
  canonicalWorkingCopies,
  completionItems,
  createEditorSourceMap,
  type DocumentDiagnostic,
  displayDocumentation,
  documentDiagnosticRefreshKey,
  mergeDocumentDiagnostics,
  normalizeEditorSource,
  offsetAt,
  offsets,
  positionAt,
  preferredLineSeparator,
  textChanges,
} from "../ui/editor-language-model.js";

await describe("editor language protocol source mapping", async () => {
  await it("uses UTF-16 offsets across CRLF, astral characters and empty final lines", () => {
    const source = "a😀\r\nlast\n";
    strict.deepEqual(positionAt(source, 3), { line: 0, character: 3 });
    strict.equal(offsetAt(source, { line: 1, character: 2 }), 7);
    strict.equal(offsetAt(source, { line: 0, character: 200 }), 3);
    strict.equal(offsetAt(source, { line: 2, character: 0 }), source.length);
    strict.equal(offsetAt(source, { line: -1, character: 0 }), undefined);
    strict.equal(offsetAt(source, { line: 0, character: -1 }), undefined);
    strict.equal(offsetAt(source, { line: 5, character: 0 }), undefined);
    strict.equal(offsets(source, { start: { line: 1, character: 2 }, end: { line: 0, character: 1 } }), undefined);
  });
  await it("keeps independent import and completion edits in one original coordinate space", () => {
    const source = "const example = acc;\n";
    const edits = [
      { range: { start: { line: 0, character: 16 }, end: { line: 0, character: 19 } }, newText: "account" },
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "import { account } from './db.js';\n",
      },
    ];
    strict.deepEqual(textChanges(source, edits), [
      { from: 0, to: 0, insert: "import { account } from './db.js';\n" },
      { from: 16, to: 19, insert: "account" },
    ]);
    strict.equal(textChanges(source, [...edits, edits[0]!]), undefined);
    strict.equal(
      textChanges(source, [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 18 } }, newText: "" },
        edits[0]!,
      ]),
      undefined,
    );
  });
  await it("merges host and language-server copies of one typed-sql finding without losing the full span", () => {
    const host = {
      code: "TSQ202",
      message: "TSQ202: Unknown function CONCAT",
      severity: "error",
      range: { line: 1, column: 8 },
    };
    const language = {
      code: "TSQ202",
      message: "Unknown function CONCAT",
      severity: "error",
      source: "typed-sql",
      origin: "language-server",
      range: { line: 1, column: 8, start: 7, end: 13 },
    };
    const merged = mergeDocumentDiagnostics<DocumentDiagnostic>([host, language]);
    strict.equal(merged.length, 1);
    strict.equal(merged[0]?.message, "Unknown function CONCAT");
    strict.deepEqual(merged[0]?.range, language.range);
    strict.equal(merged[0]?.origin, "language-server");
    strict.equal(host.message, "TSQ202: Unknown function CONCAT", "Original transport evidence remains unchanged");
    strict.equal(
      mergeDocumentDiagnostics([
        {
          code: language.code,
          message: language.message,
          severity: language.severity,
          origin: language.origin,
          source: language.source,
          from: 7,
          to: 13,
        },
        { code: host.code, message: host.message, severity: host.severity, from: 7, to: 7, source: "typed-sql TSQ202" },
      ]).length,
      1,
    );
  });
  await it("preserves different codes, occurrences, severities, messages and diagnostic producers", () => {
    const host = {
      code: "TSQ202",
      message: "TSQ202: Unknown function CONCAT",
      severity: "error",
      range: { line: 1, column: 8 },
    };
    const values = [
      host,
      { ...host, code: "TSQ203", message: "Unknown function CONCAT" },
      { ...host, range: { line: 1, column: 20 } },
      { ...host, severity: "warning" },
      { ...host, message: "Unknown function OTHER" },
      { ...host, origin: "database", engine: "postgres", sourceRevision: "capture-a" },
      { ...host, origin: "database", engine: "postgres", sourceRevision: "capture-b" },
      { ...host, origin: "custom-provider", source: "typed-sql" },
      { ...host, origin: "language-server", source: "other-linter" },
    ];
    strict.equal(mergeDocumentDiagnostics(values).length, values.length);
    const unlocated = { code: host.code, message: host.message, severity: host.severity };
    strict.equal(
      mergeDocumentDiagnostics([unlocated, unlocated]).length,
      2,
      "Unlocated findings cannot be proven to be the same occurrence",
    );
    strict.equal(
      mergeDocumentDiagnostics([{ ...host, message: "TSQ2020: distinct content" }])[0]?.message,
      "TSQ2020: distinct content",
    );
  });
  await it("maps original UTF-16 spans into normalized display text without accepting changed content", () => {
    const original = "select '😀' as emoji,\r\n  missing\r\nfrom accounts;\rlast";
    const displayed = normalizeEditorSource(original);
    const mapping = createEditorSourceMap(original, displayed);
    if (!mapping) throw new Error("Expected matching normalized source");
    const start = original.indexOf("missing");
    strict.deepEqual(mapping.range({ line: 2, column: 3, start, end: start + 7 }), {
      from: displayed.indexOf("missing"),
      to: displayed.indexOf("missing") + 7,
    });
    for (let offset = 0; offset <= original.length; offset++)
      strict.equal(mapping.offset(offset), normalizeEditorSource(original.slice(0, offset)).length);
    strict.deepEqual(mapping.range({ line: 2, column: 3 }), {
      from: displayed.indexOf("missing"),
      to: displayed.indexOf("missing"),
    });
    strict.equal(mapping.offset(-1), undefined);
    strict.equal(mapping.offset(original.length + 1), undefined);
    strict.equal(mapping.range({ line: 1, column: 1, start: 20, end: 10 }), undefined);
    strict.equal(createEditorSourceMap(original, `${displayed} changed`), undefined);
    strict.equal(preferredLineSeparator(original), "\r\n");
    strict.equal(preferredLineSeparator("first\rlast"), "\r");
    strict.equal(preferredLineSeparator("one line"), "\n");
  });
  await it("retains complete diagnostic source identities only once in refresh metadata", () => {
    const sourceText = "content\r\n".repeat(1000);
    const diagnostics = Array.from({ length: 20 }, (_, index) => ({
      code: "TSQ202",
      severity: "warning",
      message: "Unknown function",
      range: { line: index + 1, column: 1 },
      sourceText,
    }));
    const key = documentDiagnosticRefreshKey(diagnostics);
    strict.ok(key.length < sourceText.length * 3, "A repeated source buffer must not be serialized for every finding");
    strict.notEqual(
      key,
      documentDiagnosticRefreshKey(
        diagnostics.map((diagnostic) => ({ ...diagnostic, sourceText: normalizeEditorSource(sourceText) })),
      ),
    );
  });
  await it("canonicalizes only other dirty buffers with a deterministic transport identity", () => {
    const withPrivateState = { file: "z.ts", source: "z", revision: "2", privateNote: "never transport" };
    strict.equal(
      JSON.stringify(
        canonicalWorkingCopies(
          [
            withPrivateState,
            { file: "current.ts", source: "current", revision: "0" },
            { file: "a.ts", source: "😀\r\n", revision: "1" },
          ],
          "current.ts",
        ),
      ),
      '[{"file":"a.ts","source":"😀\\r\\n","revision":"1"},{"file":"z.ts","source":"z","revision":"2"}]',
    );
  });
  await it("honors LSP completion-list default edit ranges and rejects non-items", () => {
    strict.deepEqual(
      completionItems({
        itemDefaults: {
          editRange: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } },
          insertTextFormat: 2,
        },
        items: [null, { label: "account", insertText: "account(${1:id})" }],
      }),
      [
        {
          label: "account",
          insertText: "account(${1:id})",
          insertTextFormat: 2,
          textEdit: {
            range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } },
            newText: "account(${1:id})",
          },
        },
      ],
    );
    strict.equal(
      displayDocumentation({ language: "typescript", value: "const name: string" }),
      "```typescript\nconst name: string\n```",
    );
    strict.equal(displayDocumentation([{ kind: "markdown", value: "type" }, "notes"]), "type\n\nnotes");
    strict.equal(displayDocumentation({ invalid: true }), "");
  });
});
