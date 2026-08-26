export interface ReleasePackagePolicy {
  readonly stable: readonly string[];
  readonly experimental: readonly string[];
}

export interface ReleaseManifest {
  readonly channel: "beta" | "rc" | "stable";
  readonly series: string;
  readonly npmTag: "next" | "latest";
  readonly sourceCandidate?: string;
  readonly packages: readonly string[];
  readonly packagePolicy: ReleasePackagePolicy;
}

export function validateReleaseManifest(value: unknown): ReleaseManifest;
export function loadReleaseManifest(workspace: string): Promise<ReleaseManifest>;
