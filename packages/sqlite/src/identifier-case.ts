/** SQLite identifier/keyword comparison folds ASCII letters, independently of Unicode casing. */
export const sqliteAsciiFold = (value: string): string => value.replace(/[A-Z]+/gu, (part) => part.toLowerCase());
export const sqliteAsciiUpper = (value: string): string => value.replace(/[a-z]+/gu, (part) => part.toUpperCase());
