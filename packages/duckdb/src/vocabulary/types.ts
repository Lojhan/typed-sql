export type DuckDBKeywordDeclaration = readonly [name: string, classes: string];
export interface DuckDBKeyword {
  readonly name: string;
  readonly classes: string;
  readonly identifier: boolean;
  readonly functionName: boolean;
  readonly typeName: boolean;
  readonly bareLabel: boolean;
}
export interface DuckDBVocabulary {
  lookup(word: string): DuckDBKeyword | undefined;
}
