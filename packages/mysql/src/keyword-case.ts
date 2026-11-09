/** Lexical keywords and native built-ins use ASCII comparison; identifier collation is a separate policy. */
export const mySqlKeywordUpper = (value: string): string => value.replace(/[a-z]+/gu, (part) => part.toUpperCase());
