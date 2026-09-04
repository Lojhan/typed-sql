import type { SourceAnalysisBinding, SourceAnalysisInsertion } from "./analysis.js";

/** Index declaration suffixes once rather than searching every source prefix. */
export function sourceBindings(source: string): ReadonlyMap<number, SourceAnalysisBinding> {
  const bindings = new Map<number, SourceAnalysisBinding>();
  const pattern = /(?:^|[;{}]\s*|\n\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/gu;
  for (const match of source.matchAll(pattern)) {
    const name = match[1]!;
    const start = match.index + match[0].lastIndexOf(name);
    bindings.set(match.index + match[0].length, { name, range: { start, end: start + name.length } });
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
