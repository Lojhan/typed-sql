import { currentTimeKeywords } from "./generated/policy.js";

export { dateTimeFunctions as SQLITE_DATE_TIME_FUNCTIONS } from "./generated/policy.js";
export const SQLITE_CURRENT_TIME_KEYWORDS: ReadonlySet<string> = Object.freeze(new Set(currentTimeKeywords));
