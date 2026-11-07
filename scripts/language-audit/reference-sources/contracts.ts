import type { inventory } from "../records.mjs";

export interface ReferenceFunction {
  name: string;
  url: string;
}

export interface ReferenceCollection {
  functions: ReferenceFunction[];
  categories: Record<string, ReturnType<typeof inventory>>;
}

/** Documentation is recognition evidence; presence never establishes native semantics. */
export interface ReferenceSource {
  id: string;
  referenceVersions(): readonly string[];
  captureVersions(): readonly string[];
  minimumFunctions: number;
  scope: string;
  extractFunctions?(body: string, url: string): ReferenceFunction[];
  collect?(version: string, page: (url: string) => Promise<string>): Promise<ReferenceCollection>;
}

export type ReferenceSourceDefinition = { id: string; extends?: string } & Partial<Omit<ReferenceSource, "id">>;
