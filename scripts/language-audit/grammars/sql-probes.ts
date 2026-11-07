/** Explicit opt-in for owners using standard CAST and infix expression spelling. */
export function standardEntityProbe(category: string, name: string): string | undefined {
  if (category === "types" && /^[a-z_][a-z_0-9 ]*$/iu.test(name)) return `SELECT CAST(NULL AS ${name}) AS value`;
  if (category === "operators" && /^[~!@#%^&|*+=<>/?-]+$/u.test(name)) return `SELECT NULL ${name} NULL AS value`;
  return undefined;
}
