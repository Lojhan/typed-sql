export type ReleaseEvidenceChannelName = "development" | "beta" | "rc" | "stable";

export interface ReleaseEvidenceChannel {
  readonly required: readonly string[];
}

export interface ReleaseEvidencePolicy {
  readonly formatVersion: 1;
  readonly channels: Readonly<Record<ReleaseEvidenceChannelName, ReleaseEvidenceChannel>>;
}

export function validateReleaseEvidencePolicy(value: unknown): ReleaseEvidencePolicy;
export function loadReleaseEvidencePolicy(workspace: string): Promise<ReleaseEvidencePolicy>;
