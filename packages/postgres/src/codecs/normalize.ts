import { postgresAsciiFold } from "../identifier-case.js";
export function normalizePostgresDatabaseType(value: string): string {
  const normalized = postgresAsciiFold(value.trim())
    .replace(/\[\]$/u, "")
    .replace(/\(\d+(?:,\s*\d+)?\)/gu, "")
    .replace(/\s+/gu, " ");
  return /^interval(?:\s|$)/u.test(normalized) ? "interval" : normalized;
}
