/** PostgreSQL UTF-8 identifiers and keywords fold ASCII letters without Unicode compatibility folding. */
export const postgresAsciiFold = (value: string): string => value.replace(/[A-Z]+/gu, (part) => part.toLowerCase());
export const postgresAsciiUpper = (value: string): string => value.replace(/[a-z]+/gu, (part) => part.toUpperCase());
