export type AnalysisTab = `@analysis:${string}`;
export const analysisTab = (id: string, title = "Analysis"): AnalysisTab =>
  `@analysis:${id}~${encodeURIComponent(title)}`;
export const analysisId = (tab: string) => /^@analysis:([a-f0-9-]{36})(?:~.*)?$/u.exec(tab)?.[1];
export function analysisTitle(tab: string) {
  if (!analysisId(tab)) return undefined;
  try {
    return decodeURIComponent(tab.includes("~") ? tab.slice(tab.indexOf("~") + 1) : "Analysis");
  } catch {
    return "Analysis";
  }
}
