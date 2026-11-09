export type SqliteKeywordCondition =
  | boolean
  | string
  | readonly ["not", SqliteKeywordCondition]
  | readonly ["and" | "or", SqliteKeywordCondition, SqliteKeywordCondition];
export type SqliteKeywordMasks = Readonly<Record<string, SqliteKeywordCondition>>;
/** Source token, build masks, ID fallback condition, direct expression/bare-alias/name flags, contextual classifier. */
export type SqliteKeywordDeclaration = readonly [
  string,
  string,
  readonly string[],
  SqliteKeywordCondition,
  number,
  boolean,
  boolean,
  boolean,
];
export interface SqliteKeyword {
  readonly name: string;
  readonly token: string;
  readonly expression: boolean;
  readonly bareAlias: boolean;
  readonly bareColumnAlias: boolean;
  readonly identifier: boolean;
  readonly contextual: boolean;
  readonly fallback: boolean;
  readonly lookahead: boolean;
}
export interface SqliteKeywordLookup {
  (word: string): SqliteKeyword | undefined;
  readonly isDeclared: (word: string) => boolean;
}
export interface SqliteVocabulary {
  readonly declarations: readonly SqliteKeywordDeclaration[];
  forOptions(options?: readonly string[]): SqliteKeywordLookup;
}
