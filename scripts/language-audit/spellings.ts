let unicodeFolds: readonly { ascii: string; spelling: string; code: string }[] | undefined;

/** Discover the host's ASCII-equivalent Unicode casing, rather than maintaining a character list. */
function asciiEquivalents() {
  if (unicodeFolds) return unicodeFolds;
  const result: { ascii: string; spelling: string; code: string }[] = [];
  for (let point = 128; point <= 0x10ffff; point++) {
    if (point >= 0xd800 && point <= 0xdfff) continue;
    const spelling = String.fromCodePoint(point);
    const seen = new Set<string>();
    for (const folded of [spelling.toUpperCase(), spelling.toLowerCase()]) {
      if (!/^[A-Za-z]+$/u.test(folded)) continue;
      const ascii = folded.toUpperCase();
      if (seen.has(ascii)) continue;
      seen.add(ascii);
      result.push({ ascii, spelling, code: point.toString(16) });
    }
  }
  unicodeFolds = result;
  return result;
}

/** Mutations are candidates, not declarations of engine equivalence; the native oracle decides. */
export function spellingVariants(name: string): readonly { kind: string; spelling: string }[] {
  const result = [
    { kind: "uppercase", spelling: name.toUpperCase() },
    { kind: "lowercase", spelling: name.toLowerCase() },
    ...asciiEquivalents().map(({ ascii, spelling, code }) => ({
      kind: `unicode-fold-${code}`,
      spelling: name.replace(new RegExp(ascii, "gi"), (part) => (/^[A-Za-z]+$/u.test(part) ? spelling : part)),
    })),
  ];
  const seen = new Set([name]);
  return result.filter((candidate) => {
    if (seen.has(candidate.spelling)) return false;
    seen.add(candidate.spelling);
    return true;
  });
}
