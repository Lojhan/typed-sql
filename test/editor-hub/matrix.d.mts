export interface HostReport {
  editor: string;
  grammar: string;
  evidence: string;
  vscode?: string;
  hostVersion?: string;
  checks: Record<string, { status: string; error?: string }>;
}
export const pendingInterfaces: string[];
export function buildMatrix(reports: HostReport[]): {
  formatVersion: number;
  scope: string;
  cells: { editor: string; grammar: string; interface: string; status: string; reason?: string }[];
};
