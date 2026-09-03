import type { TypeScriptBackend, TypeScriptBackendSpawnOptions } from "../backend.js";
import { TYPESCRIPT_71_BACKEND_IDENTITY, TypeScript71PreviewBackend } from "./typescript-7.1.js";

export const TYPESCRIPT_BACKEND_ADAPTERS = Object.freeze([TYPESCRIPT_71_BACKEND_IDENTITY]);

export function createTypeScriptBackend(options: TypeScriptBackendSpawnOptions = {}): TypeScriptBackend {
  return TypeScript71PreviewBackend.spawn(options);
}

export { TypeScript71PreviewBackend } from "./typescript-7.1.js";
