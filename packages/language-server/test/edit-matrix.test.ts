import { describe, it, strict } from "poku";
import { mapProtocolCoordinates } from "../src/protocol-mapping.js";

const caller = "file:///project/query.ts";
const target = "file:///project/consumer.ts";
const dependency = "file:///external/index.d.ts";
const range = { start: { line: 20, character: 2 }, end: { line: 21, character: 5 } };
const shifted = (delta: number) => ({
  start: { line: 20 - delta, character: 2 },
  end: { line: 21 - delta, character: 5 },
});
const lookup = (uri: string) => (uri === caller ? 3 : uri === target ? 7 : undefined);
const mapper = {
  lookup,
  position: (delta: number, value: { line: number; character: number }) => ({ ...value, line: value.line - delta }),
  version: (delta: number, version: number) => version - delta,
};

await describe("edit-bearing protocol matrix", async () => {
  for (const [uri, delta] of [
    [caller, 3],
    [target, 7],
    [dependency, 0],
  ] as const) {
    await it(`maps plain, insert/replace, additional and resolved edits owned by ${uri}`, () => {
      const opaque = { uri: caller, range, version: 999, newText: "opaque" };
      const input = {
        uri,
        textEdit: { insert: range, replace: range, newText: "renamed" },
        additionalTextEdits: [{ range, newText: "imported" }],
        data: opaque,
      };
      const projected = mapProtocolCoordinates(input, mapper, 3);
      strict.deepStrictEqual(projected, {
        ...input,
        textEdit: { insert: shifted(delta), replace: shifted(delta), newText: "renamed" },
        additionalTextEdits: [{ range: shifted(delta), newText: "imported" }],
      });
      strict.strictEqual((projected as typeof input).data, opaque);
      strict.deepStrictEqual(
        mapProtocolCoordinates(
          projected,
          { ...mapper, position: (amount, value) => ({ ...value, line: value.line + amount }) },
          3,
        ),
        input,
      );
    });
    for (const version of [null, 12]) {
      await it(`maps annotated/versioned edits for ${uri} at version ${version}`, () => {
        const input = {
          documentChanges: [
            { textDocument: { uri, version }, edits: [{ range, newText: "replacement", annotationId: "safe" }] },
          ],
          changeAnnotations: { safe: { label: "Replace original identifier", needsConfirmation: true } },
        };
        strict.deepStrictEqual(mapProtocolCoordinates(input, mapper, 3), {
          ...input,
          documentChanges: [
            {
              textDocument: { uri, version: version === null ? null : version - delta },
              edits: [{ range: shifted(delta), newText: "replacement", annotationId: "safe" }],
            },
          ],
        });
      });
    }
  }
  await it("preserves resource operations and resolves each URI-keyed edit independently", () => {
    const input = {
      edit: {
        changes: {
          [caller]: [{ range, newText: "a" }],
          [target]: [{ range, newText: "b" }],
          [dependency]: [{ range, newText: "c" }],
        },
        documentChanges: [{ kind: "rename", oldUri: caller, newUri: target, options: { overwrite: false } }],
      },
    };
    strict.deepStrictEqual(mapProtocolCoordinates(input, mapper, 3), {
      edit: {
        ...input.edit,
        changes: {
          [caller]: [{ range: shifted(3), newText: "a" }],
          [target]: [{ range: shifted(7), newText: "b" }],
          [dependency]: [{ range, newText: "c" }],
        },
      },
    });
  });
});
