export type ReleaseEvidenceChannelName = "development" | "beta" | "rc" | "stable";
export type PromotionKind = "package" | "grammar" | "editor";

export interface ReleaseEvidenceChannel {
  readonly required: readonly string[];
  readonly stableClaimsAllowed: boolean;
  readonly minimumSuccessfulCandidates?: number;
}

export interface ReleaseEvidencePolicy {
  readonly formatVersion: 1;
  readonly channels: Readonly<Record<ReleaseEvidenceChannelName, ReleaseEvidenceChannel>>;
  readonly promotion: Readonly<Record<PromotionKind, readonly string[]>>;
  readonly supportTargetChange: readonly string[];
}

export function validateReleaseEvidencePolicy(value: unknown): ReleaseEvidencePolicy;
export function loadReleaseEvidencePolicy(workspace: string): Promise<ReleaseEvidencePolicy>;
