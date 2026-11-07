/** Subsequence matching with a preference for contiguous words and path boundaries. */
export function matchCommand(label: string, query: string): number | null {
  const text = label.toLocaleLowerCase(),
    needle = query.trim().toLocaleLowerCase();
  if (!needle) return 0;
  let cursor = 0,
    score = 0,
    previous = -2;
  for (const char of needle) {
    const at = text.indexOf(char, cursor);
    if (at < 0) return null;
    score += at === previous + 1 ? 0 : 4;
    score += at === 0 || /[\s/_.-]/u.test(text[at - 1] ?? "") ? -2 : 0;
    score += at / 100;
    previous = at;
    cursor = at + 1;
  }
  return score + (text.length - needle.length) / 1000;
}
