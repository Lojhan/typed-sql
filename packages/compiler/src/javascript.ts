import type { CompileSourceResult } from "./compiler.js";

const identifier = "[$_\\p{ID_Start}][$_\\u200C\\u200D\\p{ID_Continue}]*";
const staticTag = new RegExp(`^${identifier}(?:\\s*\\.\\s*${identifier})*$`, "u");
/** Types stay inside a comment; closing-comment text in SQL-derived names must remain inert. */
const jsdocType = (type: string) =>
  type.replaceAll("*/", "*\\/").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");

/** Preserve the checked tag call, rather than asserting away the final Query or its interpolation checks. */
export function javascriptProjection(
  source: string,
  compiled: CompileSourceResult,
  maximumBytes: number,
): CompileSourceResult {
  const fail = (code: string, message: string): CompileSourceResult => ({
    transformedSource: source,
    insertions: [],
    queries: [],
    fragments: [],
    diagnostics: [
      ...compiled.diagnostics,
      { code, message, severity: "error", range: { start: 0, end: Math.min(source.length, 1), line: 1, column: 1 } },
    ],
  });
  const edits: { position: number; text: string }[] = [];
  for (const { query, rowType, parameterType, fragmentList } of compiled.queries) {
    const tag = source.slice(query.range.start, query.insertionPosition);
    if (!staticTag.test(tag)) return fail("TSQ005", "JavaScript SQL overlays require a statically named grammar tag.");
    const method = fragmentList ? "__typedRow" : "__typed";
    const parameters = fragmentList ? rowType : `${rowType}, ${parameterType}`;
    edits.push(
      { position: query.range.start, text: `(/** @type {typeof ${tag}.${method}<${jsdocType(parameters)}>} */ (` },
      { position: query.insertionPosition, text: `.${method})())` },
    );
  }
  for (const { fragment, parameterType } of compiled.fragments) {
    const tag = source.slice(fragment.range.start, fragment.insertionPosition);
    if (!staticTag.test(tag))
      return fail("TSQ005", "JavaScript fragment overlays require a statically named grammar tag.");
    edits.push(
      { position: fragment.range.start, text: `(/** @type {typeof ${tag}<${jsdocType(parameterType)}>} */ (` },
      { position: fragment.insertionPosition, text: "))" },
    );
  }
  edits.sort((a, b) => a.position - b.position);
  if (edits.reduce((total, edit) => total + Buffer.byteLength(edit.text), 0) > maximumBytes)
    return fail("TSQ006", "JavaScript SQL overlays exceed the configured generated declaration limit.");
  const chunks: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    chunks.push(source.slice(cursor, edit.position), edit.text);
    cursor = edit.position;
  }
  chunks.push(source.slice(cursor));
  const transformedSource = chunks.join("");
  return { ...compiled, transformedSource, insertions: edits };
}
