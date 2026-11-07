/** Required projection facts never fall back to opaque native payloads.
 * @template T
 * @param {{status: 'known', value: T} | {status: 'unknown', reason: string}} fact
 * @param {string} label
 * @returns {T}
 */
export function requireKnown(fact, label) {
  if (fact?.status !== "known") throw new TypeError(`Unqualified projection fact: ${label}`);
  return fact.value;
}
/** @param {import('@sinclair/typebox').Static<typeof import('./schema.mjs').TypeExpressionSchema>} expression @param {string} label */
export function nativeIdentity(expression, label) {
  if (expression?.kind !== "native") throw new TypeError(`Unqualified native type expression: ${label}`);
  return expression.identity;
}
/** @param {import('./groups.mjs').CatalogGroup} group @param {string} category */
export function commonEntities(group, category) {
  const facts = group.categories[category];
  if (!facts || facts.unavailable.length)
    throw new TypeError(`Unavailable projection category: ${group.grammar}/${group.band}/${category}`);
  return facts.common.map((entry) => entry.entity);
}
