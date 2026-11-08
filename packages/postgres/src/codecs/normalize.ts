export function normalizePostgresDatabaseType(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\[\]$/u, "")
    .replace(/\(\d+(?:,\s*\d+)?\)/gu, "")
    .replace(/\s+/gu, " ");
  return /^interval(?:\s|$)/u.test(normalized) ? "interval" : normalized;
}
