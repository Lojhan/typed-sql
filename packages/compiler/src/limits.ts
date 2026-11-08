export const DEFAULT_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_STRUCTURAL_VARIANTS = 64;
export const DEFAULT_MAX_QUERIES = 10_000;
export const DEFAULT_MAX_GENERATED_DECLARATION_BYTES = 8 * 1024 * 1024;
export function positiveCompilerLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return limit;
}
