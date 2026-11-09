/** Compact runtime projection; full vendor tokens and declarations stay in audit facts. */
export const MySqlKeywordFlags = Object.freeze({
  reserved: 1,
  specialFunction: 2,
  hintable: 4,
  functionHead: 8,
  bareFunction: 16,
  ordinaryFunction: 32,
  infix: 64,
} as const);
