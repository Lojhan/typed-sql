import { describe, it, strict } from "poku";
import { mapProtocolCoordinates } from "../src/protocol-mapping.js";

const first = "file:///project/first.ts";
const second = "file:///project/second.ts";
const external = "file:///dependency/index.d.ts";
const range = { start: { line: 20, character: 1 }, end: { line: 20, character: 4 } };
const shifted = (amount: number) => ({
  start: { line: 20 - amount, character: 1 },
  end: { line: 20 - amount, character: 4 },
});
const mapper = {
  lookup: (uri: string) => (uri === first ? 3 : uri === second ? 7 : undefined),
  position: (shift: number, position: { line: number; character: number }) => ({
    ...position,
    line: position.line - shift,
  }),
};

await describe("cross-document LSP coordinates", async () => {
  await it("maps URI-keyed workspace edits in each file, including unindexed dependencies", () => {
    const input = {
      changes: {
        [first]: [{ range, newText: "a" }],
        [second]: [{ range, newText: "b" }],
        [external]: [{ range, newText: "c" }],
      },
    };
    strict.deepStrictEqual(mapProtocolCoordinates(input, mapper, 3), {
      changes: {
        [first]: [{ range: shifted(3), newText: "a" }],
        [second]: [{ range: shifted(7), newText: "b" }],
        [external]: [{ range, newText: "c" }],
      },
    });
    strict.deepStrictEqual(input.changes[second]?.[0]?.range, range);
  });

  await it("separates a definition link's origin and target document", () => {
    const input = { originSelectionRange: range, targetUri: second, targetRange: range, targetSelectionRange: range };
    strict.deepStrictEqual(mapProtocolCoordinates(input, mapper, 3), {
      ...input,
      originSelectionRange: shifted(3),
      targetRange: shifted(7),
      targetSelectionRange: shifted(7),
    });
    strict.deepStrictEqual(mapProtocolCoordinates({ ...input, targetUri: external }, mapper, 3), {
      ...input,
      targetUri: external,
      originSelectionRange: shifted(3),
    });
  });

  await it("honors explicit locations and versioned document-edit ownership", () => {
    strict.deepStrictEqual(
      mapProtocolCoordinates(
        [
          { uri: second, range },
          { uri: external, range },
        ],
        mapper,
        3,
      ),
      [
        { uri: second, range: shifted(7) },
        { uri: external, range },
      ],
    );
    strict.deepStrictEqual(
      mapProtocolCoordinates(
        { documentChanges: [{ textDocument: { uri: second, version: 2 }, edits: [{ range, newText: "x" }] }] },
        mapper,
        3,
      ),
      {
        documentChanges: [{ textDocument: { uri: second, version: 2 }, edits: [{ range: shifted(7), newText: "x" }] }],
      },
    );
  });

  await it("preserves opaque resolve data, including position-looking values", () => {
    const data = { uri: second, position: range.start, nested: { changes: { [first]: [range] } } };
    const mapped = mapProtocolCoordinates({ range, data }, mapper, 3) as { range: unknown; data: unknown };
    strict.deepStrictEqual(mapped.range, shifted(3));
    strict.strictEqual(mapped.data, data);
  });

  await it("translates owned numeric document versions without touching null or opaque versions", () => {
    const versions = { ...mapper, version: (shift: number, version: number) => version + shift };
    const input = {
      documentChanges: [
        { textDocument: { uri: first, version: 10 }, edits: [{ range, newText: "a" }] },
        { textDocument: { uri: second, version: 20 }, edits: [{ range, newText: "b" }] },
        { textDocument: { uri: external, version: 30 }, edits: [] },
        { textDocument: { uri: first, version: null }, edits: [] },
      ],
      data: { textDocument: { uri: first, version: 10 } },
    };
    const result = mapProtocolCoordinates(input, versions) as typeof input;
    strict.deepStrictEqual(
      result.documentChanges.map((edit) => edit.textDocument.version),
      [13, 27, 30, null],
    );
    strict.strictEqual(result.data, input.data);
    strict.deepStrictEqual(result.documentChanges[0]?.edits[0]?.range, shifted(3));
    const reversed = mapProtocolCoordinates(result, {
      ...versions,
      position: (shift, position) => ({ ...position, line: position.line + shift }),
      version: (shift, version) => version - shift,
    });
    strict.deepStrictEqual(reversed, input);
    strict.throws(
      () =>
        mapProtocolCoordinates(input, {
          ...versions,
          version: () => {
            throw new Error("stale version");
          },
        }),
      /stale version/u,
    );
  });
});
