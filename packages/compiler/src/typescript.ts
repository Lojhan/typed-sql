export type TypeScriptCompilerVersionSupport = "supported" | "untested-patch" | "unsupported-line" | "unknown";

export const TYPESCRIPT_COMPILER_SUPPORT_POLICY = Object.freeze({
  line: "7.0",
  exactVersion: "7.0.2",
  compatibility: "exact-tested-patch",
  unsupportedVersion: "reject-before-type-check",
} as const);

export class TypeScriptCompilerCompatibilityError extends Error {
  readonly code = "TYPESCRIPT_COMPILER_VERSION_UNSUPPORTED";
  readonly actualVersion: string;
  readonly expectedVersion = TYPESCRIPT_COMPILER_SUPPORT_POLICY.exactVersion;

  constructor(actualVersion: string) {
    super(
      `typed-sql requires TypeScript ${TYPESCRIPT_COMPILER_SUPPORT_POLICY.exactVersion} for native checking; found ${actualVersion}. Install the exact supported TypeScript patch and retry.`,
    );
    this.name = "TypeScriptCompilerCompatibilityError";
    this.actualVersion = actualVersion;
  }
}

function versionLine(value: string): string | undefined {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/u.exec(value.trim());
  return match === null ? undefined : `${match[1]}.${match[2]}`;
}

export function typeScriptCompilerVersionSupport(value: string): TypeScriptCompilerVersionSupport {
  const normalized = value.trim();
  if (normalized === TYPESCRIPT_COMPILER_SUPPORT_POLICY.exactVersion) return "supported";
  const line = versionLine(normalized);
  if (line === undefined) return "unknown";
  return line === TYPESCRIPT_COMPILER_SUPPORT_POLICY.line ? "untested-patch" : "unsupported-line";
}

export function assertTypeScriptCompilerVersion(value: string): void {
  if (typeScriptCompilerVersionSupport(value) !== "supported") {
    throw new TypeScriptCompilerCompatibilityError(value);
  }
}
