/** PostgreSQL UTF-8 identifiers and keywords fold ASCII letters without Unicode compatibility folding. */
const ascii = /^\p{ASCII}*$/u;
export const postgresAsciiFold = (value: string): string =>
  ascii.test(value) ? value.toLowerCase() : value.replace(/[A-Z]+/gu, (part) => part.toLowerCase());
export const postgresAsciiUpper = (value: string): string =>
  ascii.test(value) ? value.toUpperCase() : value.replace(/[a-z]+/gu, (part) => part.toUpperCase());
