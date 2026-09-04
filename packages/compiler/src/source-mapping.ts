import type { SourceAnalysisBinding, SourceAnalysisInsertion } from "./analysis.js";

/** Index declaration suffixes once rather than searching every source prefix. */
export function sourceBindings(source: string): ReadonlyMap<number, SourceAnalysisBinding> {
  const bindings = new Map<number, SourceAnalysisBinding>();
  const whitespace = (index: number): boolean => index >= 0 && index < source.length && /\s/u.test(source[index]!);
  const skipWhitespace = (index: number): number => {
    while (whitespace(index)) index += 1;
    return index;
  };
  const boundary = (position: number, allowExport = true): boolean => {
    let previous = position - 1;
    let newline = false;
    while (whitespace(previous)) {
      newline ||= source[previous] === "\n";
      previous -= 1;
    }
    if (newline || position === 0 || (previous >= 0 && /[;{}]/u.test(source[previous]!))) return true;
    return (
      allowExport &&
      previous < position - 1 &&
      source.slice(previous - 5, previous + 1) === "export" &&
      boundary(previous - 5, false)
    );
  };
  // Scan fixed keywords, then consume each declaration's whitespace once. A regex
  // starting with newline + whitespace can retry an entire whitespace suffix.
  for (const match of source.matchAll(/\b(?:const|let|var)\b/gu)) {
    if (!boundary(match.index)) continue;
    const keywordEnd = match.index + match[0].length;
    const start = skipWhitespace(keywordEnd);
    if (start === keywordEnd || start === source.length || !/[A-Za-z_$]/u.test(source[start]!)) continue;
    let end = start + 1;
    while (end < source.length && /[\w$]/u.test(source[end]!)) end += 1;
    const equals = skipWhitespace(end);
    if (source[equals] !== "=") continue;
    bindings.set(skipWhitespace(equals + 1), { name: source.slice(start, end), range: { start, end } });
  }
  return bindings;
}

/** Sorted insertion positions and cumulative lengths give O(log n) offset lookup. */
export function insertionOffsets(insertions: readonly SourceAnalysisInsertion[]): (position: number) => number {
  const sums = [0];
  for (const insertion of insertions) sums.push(sums[sums.length - 1]! + insertion.length);
  return (position) => {
    let low = 0;
    let high = insertions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (insertions[middle]!.position < position) low = middle + 1;
      else high = middle;
    }
    return sums[low]!;
  };
}
