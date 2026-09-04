/** Returns limit + 1 when the edit distance cannot produce an accepted suggestion. */
function boundedDistance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  const row = Array.from({ length: left.length + 1 }, (_, index) => index);
  for (let column = 1; column <= right.length; column += 1) {
    const start = Math.max(1, column - limit);
    const end = Math.min(left.length, column + limit);
    let diagonal = row[start - 1]!;
    row[0] = column;
    if (start > 1) row[start - 1] = limit + 1;
    let minimum = row[0];
    for (let index = start; index <= end; index += 1) {
      const above = row[index]!;
      row[index] = Math.min(above + 1, row[index - 1]! + 1, diagonal + (left[index - 1] === right[column - 1] ? 0 : 1));
      diagonal = above;
      minimum = Math.min(minimum, row[index]!);
    }
    if (end < left.length) row[end + 1] = limit + 1;
    if (minimum > limit) return limit + 1;
  }
  return row[left.length]!;
}

export function closestName(name: string, candidates: readonly string[]): string | undefined {
  let closest: string | undefined;
  let limit = Math.max(2, Math.floor(name.length / 2));
  for (const candidate of candidates) {
    const distance = boundedDistance(name, candidate, limit);
    if (distance > limit) continue;
    closest = candidate;
    if (distance === 0) break;
    // Only a strictly closer candidate may replace the first equal-distance match.
    limit = distance - 1;
  }
  return closest;
}
