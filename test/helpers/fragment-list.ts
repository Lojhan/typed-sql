export const fragmentRows = [
  { id: 1n, email: "one@example.test" },
  { id: 2n, email: "two@example.test" },
  { id: 3n, email: "three@example.test" },
  { id: 4n, email: "four@example.test" },
  { id: 5n, email: "five@example.test" },
] as const;

export function fragmentListCases<Query>(
  query: (cardinality: 1 | 2 | 5) => Query,
  expectedText: (cardinality: number) => string,
) {
  return ([1, 2, 5] as const).map((cardinality) => ({
    name: `${cardinality}-rows`,
    cardinality,
    query: query(cardinality),
    expectedText: expectedText(cardinality),
    expectedValues: fragmentRows.slice(0, cardinality).flatMap(({ id, email }) => [id, email]),
  }));
}
