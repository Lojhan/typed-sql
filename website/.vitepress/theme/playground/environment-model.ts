import type { PlaygroundEnvironment } from "./dialect-browser-runtime.js";

export const ENVIRONMENT_FILE = "schema/settings.ts";
export function environmentSource(environment: PlaygroundEnvironment): string {
  return `// Analysis evidence only: the browser does not connect to or execute a database.\n// Change a version, compatibility level, collation or timezone to inspect its typing rules.\nexport const environment = ${JSON.stringify(environment, null, 2)} as const;\n`;
}
