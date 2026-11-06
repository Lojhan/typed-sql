import { describe, it, strict } from "poku";
import {
  completionItems,
  displayDocumentation,
  offsetAt,
  offsets,
  positionAt,
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
