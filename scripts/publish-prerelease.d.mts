export interface ReleasePackage {
  readonly name: string;
  readonly version: string;
  readonly directory: string;
}

export interface PrereleasePlan {
  readonly npmTag: "next";
  readonly packages: readonly ReleasePackage[];
}

export interface PublishPrereleaseOptions {
  readonly workspace?: string;
  readonly plan?: PrereleasePlan;
  readonly isPublished?: (name: string, version: string) => Promise<boolean>;
  readonly publishPackage?: (pkg: ReleasePackage, npmTag: string) => Promise<void>;
  readonly createTags?: (workspace: string) => Promise<void>;
  readonly log?: (message: string) => void;
}

export interface RegistryLookupOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly attempts?: number;
}

export function loadPrereleasePlan(workspace?: string): Promise<PrereleasePlan>;
export function isPublishedOnNpm(name: string, version: string, options?: RegistryLookupOptions): Promise<boolean>;
export function publicationCommands(
  pkg: ReleasePackage,
  npmTag: string,
  tarballPath: string,
): readonly {
  readonly command: "pnpm" | "npm";
  readonly args: readonly string[];
  readonly cwd: string;
}[];
export function publishPrerelease(options?: PublishPrereleaseOptions): Promise<void>;
export function main(): Promise<void>;
