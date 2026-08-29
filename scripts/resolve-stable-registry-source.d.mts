import type { ReleasePlan } from "./publish-prerelease.mjs";

export interface StableRegistrySource {
  readonly tag: "latest" | "next";
  readonly expected: "workspace" | undefined;
}

export interface ResolveStableRegistrySourceOptions {
  readonly workspace?: string;
  readonly plan?: ReleasePlan;
  readonly isPublished?: (name: string, version: string) => Promise<boolean>;
}

export function resolveStableRegistrySource(
  options?: ResolveStableRegistrySourceOptions,
): Promise<StableRegistrySource>;
export function main(): Promise<void>;
