// Preserve historical English ordering while removing the host's locale from artifact identity.
const collator = new Intl.Collator("en");
export const compareSchemaKeys = (left: string, right: string): number =>
  collator.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);

export const compareLegacySchemaKeys = (left: string, right: string): number => left.localeCompare(right);
