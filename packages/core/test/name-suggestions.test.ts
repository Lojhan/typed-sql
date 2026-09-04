import { describe, it, strict } from "poku";
import { closestName } from "../src/index.js";

function reference(name: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let minimum = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const matrix = Array.from({ length: name.length + 1 }, (_, row) =>
      Array.from({ length: candidate.length + 1 }, (_, column) => (row === 0 ? column : column === 0 ? row : 0)),
    );
    for (let row = 1; row <= name.length; row += 1)
      for (let column = 1; column <= candidate.length; column += 1)
        matrix[row]![column] = Math.min(
          matrix[row - 1]![column]! + 1,
          matrix[row]![column - 1]! + 1,
          matrix[row - 1]![column - 1]! + (name[row - 1] === candidate[column - 1] ? 0 : 1),
        );
    const distance = matrix[name.length]![candidate.length]!;
    if (distance < minimum) {
      best = candidate;
      minimum = distance;
    }
  }
  return minimum <= Math.max(2, Math.floor(name.length / 2)) ? best : undefined;
}

await describe("bounded name suggestions", async () => {
  await it("matches a full-matrix oracle including empty names, Unicode, and stable ties", () => {
    const words = [
      "",
      "a",
      "b",
      "ab",
      "ba",
      "aa",
      "bbb",
      "aba",
      "é",
      "😀",
      "users",
      "uesrs",
      "user_id",
      "x".repeat(60),
    ];
    for (const name of words)
      for (const left of words)
        for (const right of words) strict.strictEqual(closestName(name, [left, right]), reference(name, [left, right]));
  });
});
