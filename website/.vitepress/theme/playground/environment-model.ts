import type { PlaygroundEnvironment } from "./dialect-browser-runtime.js";

export const ENVIRONMENT_FILE = "schema/settings.ts";
/** Explicit simulated server evidence shown in the editable playground file. */
export const DEFAULT_NATIVE_ENVIRONMENTS = {
  sqlserver: {
    version: "17.0.5035.5",
    settings: {
      compatibilityLevel: 170,
      collation: "Latin1_General_100_CI_AS",
      defaultSchema: "dbo",
      quotedIdentifier: true,
      ansiWarnings: true,
      arithAbort: true,
      concatNullYieldsNull: true,
      dateFirst: 7,
      dateFormat: "mdy",
      language: "us_english",
    },
  },
  duckdb: {
    version: "2.0.0",
    settings: {
      currentCatalog: "memory",
      currentSchema: "main",
      schema: "main",
      search_path: "",
      TimeZone: "UTC",
      Calendar: "gregorian",
      integer_division: "false",
      preserve_identifier_case: "preserve_case",
      default_null_order: "NULLS_LAST",
      default_order: "ASCENDING",
    },
  },
} as const satisfies Readonly<Record<"sqlserver" | "duckdb", PlaygroundEnvironment>>;
export function environmentSource(environment: PlaygroundEnvironment): string {
  return `// Analysis evidence only: the browser does not connect to or execute a database.\n// Change a version, compatibility level, collation or timezone to inspect its typing rules.\nexport const environment = ${JSON.stringify(environment, null, 2)} as const;\n`;
}
