import type { SchemaSnapshot } from "@typed-sql/schema";
import { nativeSignatures } from "./generated/native.js";
import { postgresNativeOverloads as resolve } from "./native-resolution.js";

export type { PostgresNativeSignature } from "./native-resolution.js";
export { postgresNativeArguments } from "./native-resolution.js";
/** Compatibility lookup over every retained native profile. */
export function postgresNativeOverloads(name: string, schema: SchemaSnapshot, namespace?: string) {
  return resolve(name, schema, namespace, nativeSignatures);
}
