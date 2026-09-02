import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { TYPESCRIPT_SUPPORT_POLICY, typeScriptVersionSupport } from "./support.js";

export class TypeScriptPreviewCompatibilityError extends Error {
  readonly code = "TYPESCRIPT_PREVIEW_VERSION_UNSUPPORTED";
  readonly actualVersion: string;
  readonly expectedVersion = TYPESCRIPT_SUPPORT_POLICY.previewBackend.exactVersion;

  constructor(actualVersion: string) {
    super(
      `typed-sql requires its bundled TypeScript preview ${TYPESCRIPT_SUPPORT_POLICY.previewBackend.exactVersion}; found ${actualVersion}. Reinstall @typed-sql/language-server and @typed-sql/ts-bridge without overriding @typed-sql/typescript-preview.`,
    );
    this.name = "TypeScriptPreviewCompatibilityError";
    this.actualVersion = actualVersion;
  }
}

export function installedTypeScriptPreviewVersion(): string {
  const require = createRequire(import.meta.url);
  const packageFile = require.resolve("@typed-sql/typescript-preview/package.json");
  const manifest = JSON.parse(readFileSync(packageFile, "utf8")) as { readonly version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new TypeError(
      `TypeScript preview package metadata is invalid at ${join(dirname(packageFile), "package.json")}`,
    );
  }
  return manifest.version;
}

export function assertTypeScriptPreviewVersion(version = installedTypeScriptPreviewVersion()): void {
  if (typeScriptVersionSupport(version, "preview-backend") !== "supported") {
    throw new TypeScriptPreviewCompatibilityError(version);
  }
}
