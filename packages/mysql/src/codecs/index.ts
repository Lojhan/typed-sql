import type { SchemaSnapshot } from "@typed-sql/schema";
import { MYSQL_SUPPORT_POLICY, parseMySqlVersion } from "../support.js";
import { normalizeMySqlType } from "./normalize.js";
import type { MySqlCodecTypeMapping } from "./types.js";
import { mySqlCodecTypes } from "./types-data.js";

export function mySqlCodecTypeMapping(
  databaseType: string,
  schema?: SchemaSnapshot,
): MySqlCodecTypeMapping | undefined {
  const evidence = schema?.server?.versionKey ?? schema?.version;
  const version = evidence === undefined ? undefined : parseMySqlVersion(evidence);
  const series =
    evidence === undefined
      ? MYSQL_SUPPORT_POLICY.stable[0].series
      : version
        ? `${version[0]}.${version[1]}`
        : undefined;
  const types = series === undefined ? undefined : mySqlCodecTypes[series];
  const name = normalizeMySqlType(databaseType);
  return types && Object.hasOwn(types, name) ? types[name] : undefined;
}
