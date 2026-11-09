/** Native PostgreSQL kwlist.h classes; these do not enumerate supported SQL productions. */
export type PostgresKeywordCategory =
  | "UNRESERVED_KEYWORD"
  | "COL_NAME_KEYWORD"
  | "TYPE_FUNC_NAME_KEYWORD"
  | "RESERVED_KEYWORD";
export type PostgresKeywordDeclaration = readonly [
  name: string,
  category: PostgresKeywordCategory,
  bareLabel: boolean,
  token: string,
];
export interface PostgresKeyword {
  readonly name: string;
  readonly category: PostgresKeywordCategory;
  readonly bareLabel: boolean;
  readonly token: string;
}
export interface PostgresVocabulary {
  readonly words: readonly PostgresKeyword[];
  lookup(word: string): PostgresKeyword | undefined;
}
export type PostgresKeywordLookup = PostgresVocabulary["lookup"];
