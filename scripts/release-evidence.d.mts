export interface ReleaseException {
  readonly id: string;
  readonly gates: readonly string[];
  readonly owner: string;
  readonly reason: string;
  readonly affectedFeatures: Readonly<Record<string, "conservative" | "unsupported" | "out-of-scope">>;
  readonly expiresOn: string;
  readonly removalIssue: string;
}

export interface ReleaseExceptions {
  readonly formatVersion: 1;
  readonly exceptions: readonly ReleaseException[];
}

export interface ReleaseEvidenceInput {
  readonly formatVersion: 1;
  readonly revision: string;
  readonly lane: string;
  readonly gates: readonly string[];
}

export interface ReleaseEvidenceSource {
  readonly name: string;
  readonly sha256: string;
  readonly value: unknown;
}

export interface ReleaseEvidenceReport {
  readonly formatVersion: 1;
  readonly channel: string;
  readonly series: string;
  readonly revision: string;
  readonly complete: boolean;
  readonly publishable: boolean;
  readonly stableClaimsAllowed: boolean;
  readonly required: readonly string[];
  readonly proven: readonly string[];
  readonly missing: readonly string[];
  readonly excepted: readonly string[];
  readonly blocking: readonly string[];
  readonly exceptions: readonly ReleaseException[];
  readonly sources: readonly {
    readonly name: string;
    readonly lane: string;
    readonly gates: readonly string[];
    readonly sha256: string;
  }[];
}

export function validateReleaseExceptions(value: unknown, options?: { readonly now?: Date }): ReleaseExceptions;

export function validateReleaseEvidenceInput(value: unknown, path?: string): ReleaseEvidenceInput;

export function assembleReleaseEvidence(options: {
  readonly policy: {
    readonly channels: Readonly<
      Record<string, { readonly required: readonly string[]; readonly stableClaimsAllowed: boolean }>
    >;
  };
  readonly manifest: { readonly channel: string; readonly series: string };
  readonly exceptions: ReleaseExceptions;
  readonly inputs: readonly ReleaseEvidenceSource[];
  readonly revision: string;
}): ReleaseEvidenceReport;

export function loadEvidenceInput(path: string): Promise<ReleaseEvidenceSource>;

export function writeImmutableEvidence(path: string, report: unknown): Promise<string>;
