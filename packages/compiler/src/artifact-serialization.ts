/** Stable UTF-16 code-unit ordering used by compiler artifact identities. */
export const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}
