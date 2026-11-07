import type { NativeDescription, NativeDescriptionMapper, NativePrepare, NativeTypeOracle } from "./contracts.js";
import { duckDBDescription } from "./duckdb.js";
import { postgresDescription } from "./postgres.js";
import { sqlServerDescription } from "./sqlserver.js";

/** Explicit composition is the only list of built-in description owners. */
export const builtinDescriptionMappers = [postgresDescription, duckDBDescription, sqlServerDescription] as const;

export function createNativeDescriptionRegistry(mappers: readonly NativeDescriptionMapper[]) {
  const registrations = new Map<string, NativeDescriptionMapper>();
  for (const mapper of mappers) {
    if (!mapper.id || registrations.has(mapper.id))
      throw new TypeError(`Duplicate native description mapper: ${mapper.id}`);
    if (typeof mapper.claimSql !== "function" || typeof mapper.identity !== "function")
      throw new TypeError(`Incomplete native description mapper: ${mapper.id}`);
    registrations.set(mapper.id, Object.freeze({ ...mapper }));
  }
  return Object.freeze({
    create(id: string, prepare: NativePrepare): NativeTypeOracle | undefined {
      const mapper = registrations.get(id);
      if (!mapper) return undefined;
      const cache = new Map<string, ReturnType<NativeTypeOracle["resolve"]>>();
      return {
        identity: mapper.identity,
        resolve(databaseType) {
          let result = cache.get(databaseType);
          if (!result) {
            result = (async () => {
              // Only a type expression may be interpolated. Native preparation must never execute.
              if (!databaseType.trim() || databaseType.includes("\u0000") || /;|--|\/\*|\*\//u.test(databaseType))
                return { reason: "Claim contains a statement boundary or comment" };
              const native = await prepare(mapper.claimSql(databaseType));
              if (!native.accepted) return { reason: native.reason ?? "Engine rejected the claimed type" };
              if (!native.metadata || typeof native.metadata !== "object")
                return { reason: "Native claimed-type description unavailable" };
              const metadata = native.metadata as NativeDescription;
              if (metadata.parameterCount !== 0 || metadata.columns?.length !== 1)
                return { reason: "Claim did not describe exactly one parameter-free result" };
              return { descriptor: metadata.columns[0]! };
            })();
            cache.set(databaseType, result);
          }
          return result;
        },
      };
    },
  });
}

export const nativeDescriptionRegistry = createNativeDescriptionRegistry(builtinDescriptionMappers);
