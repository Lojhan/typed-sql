import type { ReleaseManifest } from "./release-policy.mjs";

export interface SplitChangeset {
  readonly stable?: string;
  readonly experimental?: string;
}

export interface StableVersionState {
  readonly release: ReleaseManifest;
  readonly versions: Readonly<Record<string, string>>;
}

export interface RehearsalOptions {
  readonly workspace?: string;
  readonly artifactDirectory?: string;
}

export function splitChangeset(text: string, experimentalPackages: ReadonlySet<string>): SplitChangeset;
export function prepareStableVersion(workspace: string): Promise<ReleaseManifest>;
export function assertStableVersionState(workspace: string): Promise<StableVersionState>;
export function rehearseStableRelease(options?: RehearsalOptions): Promise<string>;
