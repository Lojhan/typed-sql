function withoutTypeParameters(value: string): string {
  const parts: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    const opening = value.indexOf("(", offset);
    if (opening < 0) {
      parts.push(value.slice(offset));
      break;
    }
    const closing = value.indexOf(")", opening + 1);
    if (closing < 0) {
      parts.push(value.slice(offset));
      break;
    }
    parts.push(value.slice(offset, opening));
    offset = closing + 1;
  }
  return parts.join("");
}

function collapseWhitespace(value: string): string {
  const characters: string[] = [];
  let pendingSpace = false;
  for (const character of value) {
    if (character.trim().length === 0) {
      pendingSpace = characters.length > 0;
      continue;
    }
    if (pendingSpace) characters.push(" ");
    characters.push(character);
    pendingSpace = false;
  }
  return characters.join("");
}

export function normalizeMySqlType(value: string): string {
  let normalized = collapseWhitespace(withoutTypeParameters(value.toLowerCase()));
  for (const modifier of ["signed", "unsigned", "zerofill"]) {
    if (normalized.endsWith(` ${modifier}`)) {
      normalized = normalized.slice(0, -(modifier.length + 1));
      break;
    }
  }
  return normalized === "double precision" ? "double" : normalized;
}
