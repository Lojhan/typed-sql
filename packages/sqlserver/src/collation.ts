/** Qualified common SQL Server code pages; unmodeled collations never guess Unicode representability. */
export function sqlServerCollationCodePage(name: string): 65001 | 1252 | undefined {
  if (/^(?:Latin1_General(?:_100)?_(?:CI|CS)_(?:AS|AI)(?:_SC)?|Latin1_General(?:_100)?_BIN2)(?:_UTF8)?$/u.test(name))
    return name.endsWith("_UTF8") ? 65001 : 1252;
  if (/^SQL_Latin1_General_CP1_(?:CI|CS)_(?:AS|AI)$/u.test(name)) return 1252;
  return undefined;
}
export function validateSqlServerCollationName(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(name)) throw new TypeError("Invalid SQL Server collation identity");
  return name;
}
// Keep the repertoire explicit: Node builds can decode windows-1252 as Latin-1.
const windows1252Extra = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
function isWindows1252(point: string): boolean {
  const code = point.codePointAt(0)!;
  return code <= 0x7f || (code >= 0xa0 && code <= 0xff) || windows1252Extra.has(point);
}
export function sqlServerEncodedTextLength(value: string, collation?: string): number {
  for (const point of value) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) throw new TypeError("SQL Server text input contains an unpaired surrogate");
  }
  const page = collation ? sqlServerCollationCodePage(collation) : undefined;
  if (page === 65001) return new TextEncoder().encode(value).length;
  if (page === 1252) {
    for (const point of value)
      if (!isWindows1252(point))
        throw new RangeError("SQL Server VARCHAR input is not representable in code page 1252");
    return [...value].length;
  }
  if ([...value].some((point) => point.codePointAt(0)! > 127))
    throw new TypeError("Non-ASCII VARCHAR input requires qualified native collation evidence");
  return value.length;
}
