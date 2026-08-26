import type { ReleaseManifest } from "./release-policy.mjs";

export interface VersionPackagesOptions {
  readonly workspace?: string;
  readonly runCommand?: (command: string, args: readonly string[], cwd: string) => Promise<void>;
}

export function nextReleaseCandidateNumber(versions: Iterable<string>, series: string): number;
export function normalizeReleaseCandidateVersions(
  workspace: string,
  release: ReleaseManifest,
  originalVersions: ReadonlyMap<string, string>,
  number: number,
): Promise<string>;
export function versionPackages(options?: VersionPackagesOptions): Promise<string | undefined>;
export function main(): Promise<void>;
