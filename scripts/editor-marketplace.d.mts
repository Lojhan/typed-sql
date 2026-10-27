export function verifyComprehensiveCiRun(options: {
  readonly id: string | undefined;
  readonly sha: string | undefined;
  readonly token: string | undefined;
  readonly fetchRun?: typeof fetch;
}): Promise<void>;
export function assertMarketplaceManifest(manifest: unknown, xml: string): void;
