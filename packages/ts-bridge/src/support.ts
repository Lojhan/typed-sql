import { TYPESCRIPT_COMPILER_SUPPORT_POLICY, typeScriptCompilerVersionSupport } from "@typed-sql/compiler";

export type TypeScriptIntegrationSurface = "compiler" | "preview-backend";
export type TypeScriptVersionSupport = "supported" | "untested-patch" | "unsupported-line" | "unknown";

/**
 * Exact TypeScript versions exercised by the authoritative compiler and preview-backed editor
 * paths. A new major/minor line enters as a non-blocking canary before it can become supported.
 */
export const TYPESCRIPT_SUPPORT_POLICY = Object.freeze({
  compiler: TYPESCRIPT_COMPILER_SUPPORT_POLICY,
  previewBackend: Object.freeze({
    line: "7.1",
    exactVersion: "7.1.0-dev.20260824.1",
    compatibility: "exact-tested-patch",
    apiStability: "unstable",
  }),
  newLineAdmission: "non-blocking-canary-first",
  unsupportedVersion: "reject-before-project-load",
  promotionRequirements: Object.freeze([
    "compatibility-matrix",
    "batch-editor-parity",
    "packaged-artifacts",
    "soak-gates",
  ] as const),
} as const);

export const TYPESCRIPT_PREVIEW_VERSION = TYPESCRIPT_SUPPORT_POLICY.previewBackend.exactVersion;

function versionLine(value: string): string | undefined {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/u.exec(value.trim());
  return match === null ? undefined : `${match[1]}.${match[2]}`;
}

export function typeScriptVersionSupport(
  value: string,
  surface: TypeScriptIntegrationSurface,
): TypeScriptVersionSupport {
  if (surface === "compiler") return typeScriptCompilerVersionSupport(value);
  const target = TYPESCRIPT_SUPPORT_POLICY.previewBackend;
  const normalized = value.trim();
  if (normalized === target.exactVersion) return "supported";
  const line = versionLine(normalized);
  if (line === undefined) return "unknown";
  return line === target.line ? "untested-patch" : "unsupported-line";
}
