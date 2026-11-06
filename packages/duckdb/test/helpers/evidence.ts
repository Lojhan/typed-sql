import { duckDBServerEvidence } from "../../src/support.js";
/** Explicit fixture declarations; genuine engine evidence is read by provider/native adapter tests. */
export function fixtureEvidence(version: string, settings: Readonly<Record<string, string | number | boolean>> = {}) {
  return duckDBServerEvidence(version, [], {
    Calendar: "gregorian",
    integer_division: "false",
    preserve_identifier_case: version.replace(/^v/u, "") === "1.5.6" ? "true" : "preserve_case",
    ...(version.replace(/^v/u, "") === "1.5.6" ? { old_implicit_casting: "false" } : {}),
    ...settings,
  });
}
