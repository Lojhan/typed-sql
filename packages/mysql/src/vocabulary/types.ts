export type MySqlKeywordDeclaration = readonly [name: string, flags: number];
export interface MySqlKeyword {
  readonly name: string;
  readonly reserved: boolean;
  readonly functionReserved: boolean;
  readonly infix: boolean;
  readonly group: "keyword" | "hintable" | "function";
  readonly functionHead: boolean;
  readonly bareFunction: boolean;
  readonly ordinaryFunction: boolean;
}
export interface MySqlKeywordLookup {
  (word: string): MySqlKeyword | undefined;
  readonly ignoreSpace: boolean;
}
export interface MySqlVocabulary {
  readonly declarations: readonly MySqlKeywordDeclaration[];
  forMode(sqlMode?: string): MySqlKeywordLookup;
}
