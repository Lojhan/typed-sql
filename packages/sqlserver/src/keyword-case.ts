/** Keyword identity does not apply identifier collation or universal Unicode normalization. */
export const sqlServerKeywordUpper = (value: string): string => value.replace(/[a-z]+/gu, (part) => part.toUpperCase());
