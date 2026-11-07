export const textContent = (html: string): string =>
  html
    .replace(/<[^>]*(?:>|$)/gu, "")
    .replace(/&(?:nbsp|#160);/gu, " ")
    .replace(/&amp;/gu, "&")
    .trim();
