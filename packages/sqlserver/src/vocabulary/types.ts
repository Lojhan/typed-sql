export type SqlServerNameContext =
  | "explicit-column"
  | "bare-column"
  | "cte"
  | "explicit-relation"
  | "bare-relation"
  | "qualified-column"
  | "quoted-cte"
  | "assignment-alias";
export type SqlServerKeywordDeclaration = readonly [word: string, permissions: number];
export interface SqlServerVocabulary {
  allows(word: string, context: SqlServerNameContext): boolean;
}
