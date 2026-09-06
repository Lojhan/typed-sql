import assert from "node:assert/strict";

export const editCases = ["rename-local", "rename-cross-file", "format-document", "format-range", "quick-fix"];

function offset(source, position) {
  const lines = source.split("\n");
  assert.ok(
    Number.isInteger(position.line) && position.line >= 0 && position.line < lines.length,
    "edit line outside source",
  );
  assert.ok(
    Number.isInteger(position.character) &&
      position.character >= 0 &&
      position.character <= lines[position.line].length,
    "edit character outside source",
  );
  return lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
}

// Validate and simulate all edits before allowing a host adapter to apply any.
// Sources are the original editor buffers, not generated TypeScript overlays.
export function applySourceEdits(sources, edits) {
  const result = { ...sources };
  for (const [uri, changes] of Object.entries(edits)) {
    assert.ok(Object.hasOwn(sources, uri), `unexpected edited document: ${uri}`);
    const source = sources[uri];
    const ordered = changes
      .map(({ range, newText }) => {
        assert.equal(typeof newText, "string");
        const start = offset(source, range.start);
        const end = offset(source, range.end);
        assert.ok(start <= end, "reversed edit");
        return { start, end, newText };
      })
      .sort((a, b) => a.start - b.start || a.end - b.end);
    for (let index = 1; index < ordered.length; index++) {
      assert.ok(ordered[index - 1].end <= ordered[index].start, "overlapping edits");
      assert.ok(ordered[index - 1].start !== ordered[index].start, "ambiguous same-offset edits");
    }
    let changed = source;
    for (const { start, end, newText } of ordered.reverse())
      changed = changed.slice(0, start) + newText + changed.slice(end);
    result[uri] = changed;
  }
  return result;
}

export function assertSqlPreserved(before, after, query) {
  const literal = `sql\`${query}\``;
  assert.ok(before.includes(literal), "fixture must contain its SQL literal");
  assert.equal(after.split(literal).length, before.split(literal).length, "edit changed or duplicated SQL literal");
  // Typed overlays cast through an imported Query type. This is compiler input,
  // never acceptable new text from an ordinary editor edit.
  assert.doesNotMatch(after, /import\(["']@typed-sql\/core["']\)\.Query|__typed_sql|__typedSql/);
}
