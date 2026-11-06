import type * as NativeSDK from "@duckdb/node-api";
import type { LiveQueryVerifier, QueryPlanInspector } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { type DuckDBType, formatDuckDBType } from "./native-types.js";
import { DuckDBSchemaProvider, type DuckDBSchemaProviderOptions } from "./provider.js";
import {
  createDuckDBDatabase,
  type DuckDBBinding,
  type DuckDBConnectionLike,
  type DuckDBDatabase,
  type DuckDBDatabaseOptions,
  type DuckDBNativeResult,
  type DuckDBNativeStatement,
} from "./runtime.js";
import { assertDuckDBSemanticEvidence, DUCKDB_SEMANTIC_SETTINGS } from "./settings.js";
import { duckDBServerEvidence, duckDBVersionSupport } from "./support.js";
import { defaultDuckDBTypePolicy, validateDuckDBTypePolicy } from "./type-policy.js";
import { DUCKDB_DIALECT_VERSION } from "./version.js";
/** An SDK import is untrusted until its required capabilities are checked at runtime. */
export type DuckDBSDK = unknown;
type ValidatedDuckDBSDK = Omit<typeof NativeSDK, "default">;
export type DuckDBSDKImporter = () => Promise<DuckDBSDK>;
const packageName = "@duckdb/node-api";
const loadSDK: DuckDBSDKImporter = async () => {
  try {
    return await import(packageName);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ERR_MODULE_NOT_FOUND" &&
      error instanceof Error &&
      /^Cannot find package ['"]@duckdb\/node-api['"]/u.test(error.message)
    )
      throw new Error(
        "Install the application-owned DuckDB driver with pnpm add @duckdb/node-api before using @typed-sql/duckdb/node-api",
        { cause: error },
      );
    throw error;
  }
};
const requiredSDKFunctions = [
  "version",
  "DuckDBConnection",
  "DuckDBInstance",
  "ENUM",
  "LIST",
  "ARRAY",
  "STRUCT",
  "TUPLE",
  "MAP",
  "UNION",
  "DECIMAL",
  "listValue",
  "arrayValue",
  "tupleValue",
  "structValue",
  "unionValue",
  "mapValue",
  "decimalValue",
  "blobValue",
  "uuidValue",
  "bitValue",
  "intervalValue",
  "dateValue",
  "timeValue",
  "timeTZValue",
  "timestampSecondsValue",
  "timestampMillisValue",
  "timestampNanosValue",
  "timestampTZValue",
  "timestampValue",
] as const;
function validateSDK(value: unknown): ValidatedDuckDBSDK {
  if (typeof value !== "object" || value === null)
    throw new TypeError("DuckDB sdkImporter must return the official SDK module");
  const module = value as Readonly<Record<string, unknown>>;
  for (const name of requiredSDKFunctions) {
    if (typeof module[name] !== "function") throw new TypeError(`DuckDB SDK is missing required capability ${name}`);
  }
  if (
    typeof module.DuckDBTypeId !== "object" ||
    module.DuckDBTypeId === null ||
    typeof module.ResultReturnType !== "object" ||
    module.ResultReturnType === null
  )
    throw new TypeError("DuckDB SDK is missing native type/result metadata");
  // Native handles are accepted only after an instanceof check against these same constructors.
  // The boundary intentionally does not expose one SDK version's private class identity in declarations.
  return value as ValidatedDuckDBSDK;
}
export interface NodeDuckDBOptions extends Omit<DuckDBDatabaseOptions, "connection"> {
  readonly connection?: object;
  readonly instance?: object;
  readonly path?: string;
  readonly configuration?: Readonly<Record<string, string>>;
  readonly sdkImporter?: DuckDBSDKImporter;
  readonly ownsInstance?: boolean;
}
export class DuckDBAdapterError extends Error {
  readonly code = "DUCKDB_ADAPTER_ERROR";
  constructor(
    readonly kind: "constraint" | "conflict" | "syntax" | "connection" | "driver",
    cause: unknown,
  ) {
    super(`DuckDB ${kind} error`, { cause });
    this.name = "DuckDBAdapterError";
  }
}
function adapterError(error: unknown): Error {
  if (error instanceof TypeError || error instanceof RangeError || error instanceof DuckDBAdapterError) return error;
  const text = String(error);
  return new DuckDBAdapterError(
    /constraint|duplicate key|not null/iu.test(text)
      ? "constraint"
      : /conflict|transactioncontext/iu.test(text)
        ? "conflict"
        : /parser|binder|catalog|syntax/iu.test(text)
          ? "syntax"
          : /closed|disconnect|connection/iu.test(text)
            ? "connection"
            : "driver",
    error,
  );
}
/** Translate SDK metadata structurally, preserving aliases, tuple positions and nested native identity. */
function nativeTypeFromSDK(type: NativeSDK.DuckDBType, sdk: ValidatedDuckDBSDK): DuckDBType {
  const id = sdk.DuckDBTypeId;
  switch (type.typeId) {
    case id.DECIMAL: {
      const value = type as NativeSDK.DuckDBDecimalType;
      return { kind: "scalar", name: "DECIMAL", precision: value.width, scale: value.scale };
    }
    case id.LIST:
      return { kind: "list", element: nativeTypeFromSDK((type as NativeSDK.DuckDBListType).valueType, sdk) };
    case id.ARRAY: {
      const value = type as NativeSDK.DuckDBArrayType;
      return { kind: "array", element: nativeTypeFromSDK(value.valueType, sdk), length: value.length };
    }
    case id.STRUCT: {
      const value = type as NativeSDK.DuckDBStructType;
      return value.entryNames.length > 0 && value.entryNames.every((name) => name === "")
        ? { kind: "tuple", elements: value.entryTypes.map((item) => nativeTypeFromSDK(item, sdk)) }
        : {
            kind: "struct",
            fields: value.entryNames.map((name, i) => ({ name, type: nativeTypeFromSDK(value.entryTypes[i]!, sdk) })),
          };
    }
    case id.UNION: {
      const value = type as NativeSDK.DuckDBUnionType;
      return {
        kind: "union",
        fields: value.memberTags.map((name, i) => ({ name, type: nativeTypeFromSDK(value.memberTypes[i]!, sdk) })),
      };
    }
    case id.MAP: {
      const value = type as NativeSDK.DuckDBMapType;
      return {
        kind: "map",
        key: nativeTypeFromSDK(value.keyType, sdk),
        value: nativeTypeFromSDK(value.valueType, sdk),
      };
    }
    case id.ENUM:
      return { kind: "enum", values: [...(type as NativeSDK.DuckDBEnumType).values] };
    default: {
      let name = id[type.typeId];
      if (type.typeId === id.VARCHAR && type.alias?.toUpperCase() === "JSON") name = "JSON";
      return {
        kind: "scalar",
        name:
          (
            {
              TIMESTAMP_TZ: "TIMESTAMPTZ",
              TIMESTAMP_TZ_NS: "TIMESTAMPTZ_NS",
              TIME_TZ: "TIMETZ",
              SQLNULL: "NULL",
            } as Readonly<Record<string, string>>
          )[name] ?? name,
      };
    }
  }
}
/** Decode metadata only from the same checked SDK module that owns its native handles. */
export function duckDBTypeFromSDK(type: unknown, importedSDK: DuckDBSDK): DuckDBType {
  const sdk = validateSDK(importedSDK);
  if (typeof type !== "object" || type === null || !("typeId" in type) || typeof type.typeId !== "number")
    throw new TypeError("DuckDB metadata must contain a native type identifier");
  return nativeTypeFromSDK(type as NativeSDK.DuckDBType, sdk);
}
function sdkType(type: DuckDBType, sdk: ValidatedDuckDBSDK): NativeSDK.DuckDBType {
  switch (type.kind) {
    case "enum":
      return sdk.ENUM(type.values);
    case "list":
      return sdk.LIST(sdkType(type.element, sdk));
    case "array":
      return sdk.ARRAY(sdkType(type.element, sdk), type.length);
    case "struct":
      return sdk.STRUCT(Object.fromEntries(type.fields.map((field) => [field.name, sdkType(field.type, sdk)])));
    case "tuple":
      return sdk.TUPLE(type.elements.map((element) => sdkType(element, sdk)));
    case "map":
      return sdk.MAP(sdkType(type.key, sdk), sdkType(type.value, sdk));
    case "union":
      return sdk.UNION(Object.fromEntries(type.fields.map((field) => [field.name, sdkType(field.type, sdk)])));
    case "scalar": {
      if (type.name === "DECIMAL") return sdk.DECIMAL(type.precision, type.scale);
      const name = type.name === "JSON" ? "VARCHAR" : type.name === "NULL" ? "SQLNULL" : type.name;
      const result = (sdk as unknown as Readonly<Record<string, unknown>>)[name];
      if (!result || typeof result !== "object" || !("typeId" in result))
        throw new TypeError(`Native SDK does not support ${formatDuckDBType(type)}`);
      return result as NativeSDK.DuckDBType;
    }
  }
}
function nativeValue(binding: DuckDBBinding, sdk: ValidatedDuckDBSDK): NativeSDK.DuckDBValue {
  const { value, type } = binding;
  if (value === null) return null;
  const convert = (value: unknown, type: DuckDBType) => nativeValue({ value, type }, sdk);
  switch (type.kind) {
    case "enum":
      return value as string;
    case "list":
      return sdk.listValue((value as readonly unknown[]).map((item) => convert(item, type.element)));
    case "array":
      return sdk.arrayValue((value as readonly unknown[]).map((item) => convert(item, type.element)));
    case "tuple":
      return sdk.tupleValue((value as readonly unknown[]).map((item, i) => convert(item, type.elements[i]!)));
    case "struct":
      return sdk.structValue(
        Object.fromEntries(
          type.fields.map((field) => [
            field.name,
            convert((value as Readonly<Record<string, unknown>>)[field.name], field.type),
          ]),
        ),
      );
    case "union": {
      const item = value as { tag: string; value: unknown },
        field = type.fields.find((field) => field.name === item.tag)!;
      return sdk.unionValue(item.tag, convert(item.value, field.type));
    }
    case "map":
      return sdk.mapValue(
        (value as readonly (readonly [unknown, unknown])[]).map(([key, value]) => ({
          key: convert(key, type.key),
          value: convert(value, type.value),
        })),
      );
    case "scalar": {
      if (type.name === "DECIMAL") {
        const item = value as { value: bigint; width: number; scale: number };
        return sdk.decimalValue(item.value, item.width, item.scale);
      }
      if (type.name === "BLOB") return sdk.blobValue(value as Uint8Array);
      if (type.name === "UUID") return sdk.uuidValue(value as bigint);
      if (type.name === "BIT") return sdk.bitValue(value as string);
      if (type.name === "INTERVAL") {
        const item = value as { months: number; days: number; micros: bigint };
        return sdk.intervalValue(item.months, item.days, item.micros);
      }
      if (type.name === "DATE" || type.name.startsWith("TIME")) {
        const item = value as { ticks: bigint; offset?: number };
        switch (type.name) {
          case "DATE":
            return sdk.dateValue(Number(item.ticks));
          case "TIME":
            return sdk.timeValue(item.ticks);
          case "TIME_NS":
            if (typeof sdk.timeNSValue !== "function") throw new TypeError("This SDK does not support TIME_NS");
            return sdk.timeNSValue(item.ticks);
          case "TIMETZ":
            return sdk.timeTZValue(item.ticks, item.offset!);
          case "TIMESTAMP_S":
            return sdk.timestampSecondsValue(item.ticks);
          case "TIMESTAMP_MS":
            return sdk.timestampMillisValue(item.ticks);
          case "TIMESTAMP_NS":
            return sdk.timestampNanosValue(item.ticks);
          case "TIMESTAMPTZ_NS":
            if (typeof sdk.timestampTZNanosValue !== "function")
              throw new TypeError("This SDK does not support TIMESTAMPTZ_NS");
            return sdk.timestampTZNanosValue(item.ticks);
          case "TIMESTAMPTZ":
            return sdk.timestampTZValue(item.ticks);
          default:
            return sdk.timestampValue(item.ticks);
        }
      }
      return value as boolean | number | bigint | string;
    }
  }
}
/** Adapt an injected connection; construction never owns or closes it implicitly. */
export function adaptDuckDBConnection(connection: unknown, importedSDK: DuckDBSDK): DuckDBConnectionLike {
  const sdk = validateSDK(importedSDK);
  if (!(connection instanceof sdk.DuckDBConnection))
    throw new TypeError("DuckDB connection and sdkImporter must belong to the same SDK module");
  let tainted = false;
  const assertUsable = () => {
    if (tainted) throw new Error("DuckDB native connection is unusable after failed cleanup");
  };
  const retireNative = (close: () => void) => {
    try {
      close();
    } catch (error) {
      tainted = true;
      throw error;
    }
  };
  const libraryVersion = sdk.version();
  if (duckDBVersionSupport(libraryVersion) !== "supported")
    throw new TypeError("DuckDB SDK engine is outside the qualified version policy");
  return Object.freeze({
    identity: connection,
    libraryVersion,
    interrupt: () => connection.interrupt(),
    close: () => retireNative(() => connection.closeSync()),
    async createAppender(table: string) {
      assertUsable();
      if (typeof sdk.DuckDBDataChunk?.create !== "function")
        throw new TypeError("DuckDB SDK has no native vector appender capability");
      const appender = await connection.createAppender(table, "main", "temp");
      let closed = false;
      try {
        const columns = Array.from({ length: appender.columnCount }, (_, i) =>
          nativeTypeFromSDK(appender.columnType(i), sdk),
        );
        return {
          columns,
          append(rows: readonly (readonly DuckDBBinding[])[]) {
            assertUsable();
            if (closed) throw new Error("DuckDB appender is closed");
            if (
              rows.length < 1 ||
              rows.length > 2048 ||
              rows.some(
                (row) =>
                  row.length !== columns.length ||
                  row.some((binding, i) => formatDuckDBType(binding.type) !== formatDuckDBType(columns[i]!)),
              )
            )
              throw new TypeError("DuckDB native appender chunk shape differs from metadata");
            try {
              const chunk = sdk.DuckDBDataChunk.create(
                columns.map((type) => sdkType(type, sdk)),
                rows.length,
              );
              chunk.setRows(rows.map((row) => row.map((binding) => nativeValue(binding, sdk))));
              appender.appendDataChunk(chunk);
            } catch (error) {
              throw adapterError(error);
            }
          },
          close() {
            if (closed) return;
            closed = true;
            retireNative(() => appender.closeSync());
          },
        };
      } catch (error) {
        try {
          retireNative(() => appender.closeSync());
        } catch {}
        throw error;
      }
    },
    async readServerEvidence() {
      assertUsable();
      const read = async (text: string) => {
        const result = await connection.run(text);
        try {
          return await result.getRows();
        } finally {
          retireNative(() => result.closeSync());
        }
      };
      const current = (await read("SELECT version(),current_database(),current_schema()"))[0];
      if (!current || current.some((value) => typeof value !== "string"))
        throw new TypeError("DuckDB server evidence is invalid");
      const rows = await read(
        `SELECT name,value FROM duckdb_settings() WHERE name IN (${DUCKDB_SEMANTIC_SETTINGS.map((name) => `'${name}'`).join(",")}) ORDER BY name`,
      );
      const settings: Record<string, string> = {
        currentCatalog: String(current[1]),
        currentSchema: String(current[2]),
      };
      for (const [name, value] of rows) {
        if (typeof name !== "string" || typeof value !== "string")
          throw new TypeError("DuckDB setting evidence is invalid");
        settings[name] = value;
      }
      const extensions = await read(
        "SELECT extension_name,extension_version FROM duckdb_extensions() WHERE loaded ORDER BY extension_name",
      );
      const evidence = duckDBServerEvidence(
        String(current[0]),
        extensions.map(([name, version]) => `${name}@${version || "builtin"}`),
        settings,
      );
      assertDuckDBSemanticEvidence(evidence);
      return evidence;
    },
    async prepare(text: string): Promise<DuckDBNativeStatement> {
      assertUsable();
      if (text.includes("\0")) throw new TypeError("DuckDB SQL cannot contain NUL");
      let native: NativeSDK.DuckDBPreparedStatement;
      try {
        const extracted = await connection.extractStatements(text);
        if (extracted.count !== 1) throw new TypeError("DuckDB executes exactly one SQL statement per query");
        native = await extracted.prepare(0);
      } catch (error) {
        throw adapterError(error);
      }
      let closed = false;
      // Parameter-dependent expressions remain INVALID until execution in both qualified engines.
      let parameters: readonly (DuckDBType | undefined)[];
      try {
        parameters = Array.from({ length: native.parameterCount }, (_, i) =>
          native.parameterTypeId(i + 1) === sdk.DuckDBTypeId.INVALID
            ? undefined
            : nativeTypeFromSDK(native.parameterType(i + 1), sdk),
        );
      } catch (error) {
        try {
          retireNative(() => native.destroySync());
        } catch {}
        throw error;
      }
      const metadata = (() => {
        try {
          return Array.from({ length: native.columnCount }, (_, i) => native.columnTypeId(i)).some(
            (id) => id === sdk.DuckDBTypeId.INVALID,
          )
            ? undefined
            : Array.from({ length: native.columnCount }, (_, i) => ({
                name: native.columnName(i),
                type: nativeTypeFromSDK(native.columnType(i), sdk),
              }));
        } catch (error) {
          try {
            retireNative(() => native.destroySync());
          } catch {}
          throw error;
        }
      })();
      return Object.freeze({
        ...(metadata ? { columns: metadata } : {}),
        parameters,
        async close() {
          if (closed) return;
          closed = true;
          retireNative(() => native.destroySync());
        },
        async execute(bindings: readonly DuckDBBinding[], stream = false): Promise<DuckDBNativeResult> {
          if (closed) throw new Error("DuckDB prepared statement is closed");
          if (bindings.length !== native.parameterCount) throw new TypeError("DuckDB native parameter count differs");
          let result: NativeSDK.DuckDBResult;
          try {
            native.clearBindings();
            for (let i = 0; i < bindings.length; i++) {
              const binding = bindings[i]!;
              native.bindValue(i + 1, nativeValue(binding, sdk), sdkType(binding.type, sdk));
            }
            result = stream ? await native.stream() : await native.run();
          } catch (error) {
            throw adapterError(error);
          }
          let command: boolean;
          let columns: readonly { name: string; type: DuckDBType }[];
          try {
            command = result.returnType !== sdk.ResultReturnType.QUERY_RESULT;
            columns = command
              ? []
              : Array.from({ length: result.columnCount }, (_, i) => ({
                  name: result.columnName(i),
                  type: nativeTypeFromSDK(result.columnType(i), sdk),
                }));
          } catch (error) {
            try {
              retireNative(() => result.closeSync());
            } catch {}
            throw error;
          }
          let resultClosed = false;
          return Object.freeze({
            columns,
            async readAll() {
              if (resultClosed) throw new Error("DuckDB result is closed");
              try {
                return command ? [] : await result.getRows();
              } catch (error) {
                throw adapterError(error);
              }
            },
            async *chunks() {
              if (resultClosed) throw new Error("DuckDB result is closed");
              if (command) return;
              for (;;) {
                let chunk: NativeSDK.DuckDBDataChunk | null;
                try {
                  chunk = await result.fetchChunk();
                } catch (error) {
                  throw adapterError(error);
                }
                if (!chunk || chunk.rowCount === 0) return;
                yield chunk.getRows();
              }
            },
            async close() {
              if (resultClosed) return;
              resultClosed = true;
              retireNative(() => result.closeSync());
            },
          });
        },
      });
    },
  });
}
export async function createNodeDuckDBDatabase(options: NodeDuckDBOptions = {}): Promise<DuckDBDatabase> {
  if (options.connection && (options.instance || options.path !== undefined || options.configuration !== undefined))
    throw new TypeError("Inject a DuckDB connection or choose instance/path options");
  if (options.instance && (options.path !== undefined || options.configuration !== undefined))
    throw new TypeError("Injected DuckDB instance cannot also specify a path/configuration");
  const sdk = validateSDK(await (options.sdkImporter ?? loadSDK)());
  if (options.instance && !(options.instance instanceof sdk.DuckDBInstance))
    throw new TypeError("DuckDB instance and sdkImporter must belong to the same SDK module");
  if (options.connection && !(options.connection instanceof sdk.DuckDBConnection))
    throw new TypeError("DuckDB connection and sdkImporter must belong to the same SDK module");
  let instance = options.instance as NativeSDK.DuckDBInstance | undefined,
    connection = options.connection as NativeSDK.DuckDBConnection | undefined,
    createdInstance = false,
    createdConnection = false;
  try {
    if (!connection) {
      if (!instance) {
        instance = await sdk.DuckDBInstance.create(
          options.path ?? ":memory:",
          options.configuration ? { ...options.configuration } : undefined,
        );
        createdInstance = true;
      }
      connection = await instance.connect();
      createdConnection = true;
    }
    const base = adaptDuckDBConnection(connection, sdk),
      ownsConnection = options.ownsConnection ?? createdConnection,
      ownsInstance = options.ownsInstance ?? createdInstance;
    if (ownsInstance && !ownsConnection)
      throw new TypeError("Cannot own a DuckDB instance while leaving its connection open");
    const adapted = {
      ...base,
      async close() {
        let failure: unknown,
          failed = false;
        try {
          await base.close?.();
        } catch (error) {
          failure = error;
          failed = true;
        }
        try {
          if (ownsInstance) instance?.closeSync();
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
        if (failed) throw failure;
      },
    };
    const initialEvidence = await base.readServerEvidence!();
    return createDuckDBDatabase({
      connection: adapted,
      ownsConnection,
      compatibilitySnapshot: options.compatibilitySnapshot ?? {
        formatVersion: 1,
        dialect: "duckdb",
        tables: {},
        server: initialEvidence,
      },
      ...(options.typePolicy ? { typePolicy: options.typePolicy } : {}),
      ...(options.observer ? { observer: options.observer } : {}),
      ...(options.preparedCardinalityVariantLimit === undefined
        ? {}
        : { preparedCardinalityVariantLimit: options.preparedCardinalityVariantLimit }),
    });
  } catch (error) {
    try {
      if (createdConnection) connection?.closeSync();
    } catch {}
    try {
      if (createdInstance) instance?.closeSync();
    } catch {}
    throw error;
  }
}
/** Application-owned Node SDK provider. Build transforms consume the saved snapshot, not this client. */
export function nodeDuckDB(
  options: NodeDuckDBOptions & Pick<DuckDBSchemaProviderOptions, "catalogs" | "schemas"> = {},
) {
  return {
    async introspect() {
      const database = await createNodeDuckDBDatabase(options);
      try {
        return await new DuckDBSchemaProvider({
          client: database.queryable,
          ...(options.typePolicy ? { typePolicy: options.typePolicy } : {}),
          ...(options.catalogs ? { catalogs: options.catalogs } : {}),
          ...(options.schemas ? { schemas: options.schemas } : {}),
        }).introspect();
      } finally {
        await database.close();
      }
    },
  };
}

/** Config loading creates no SDK promise, connection, or native handle. */
function lazyDatabase(options: NodeDuckDBOptions) {
  const policy = validateDuckDBTypePolicy(options.typePolicy ?? defaultDuckDBTypePolicy);
  const captured: NodeDuckDBOptions = Object.freeze({
    ...options,
    typePolicy: policy,
    ...(options.configuration ? { configuration: Object.freeze({ ...options.configuration }) } : {}),
  });
  let closed = false;
  let initialization: Promise<DuckDBDatabase> | undefined;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  return {
    typePolicyHash: calculateTypePolicyHash(policy),
    use<T>(work: (database: DuckDBDatabase) => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error("DuckDB service is closed"));
      initialization ??= Promise.resolve().then(() => {
        if (closed) throw new Error("DuckDB service is closed");
        return createNodeDuckDBDatabase(captured);
      });
      const operation = (async () => {
        const database = await initialization;
        if (closed) throw new Error("DuckDB service is closed");
        return work(database);
      })();
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await Promise.allSettled([...pending]);
        // Database construction already retires partially created resources on failure.
        const database = await initialization?.catch(() => undefined);
        if (database) await database.close();
      })();
      return closing;
    },
  };
}
/** Lazy native prepare/describe service, directly usable in typed-sql config. */
export function createNodeDuckDBLiveVerifier(options: NodeDuckDBOptions = {}): LiveQueryVerifier {
  const database = lazyDatabase(options);
  return Object.freeze({
    dialect: "duckdb",
    adapterVersion: DUCKDB_DIALECT_VERSION,
    typePolicyHash: database.typePolicyHash,
    server: () => database.use((database) => database.liveVerifier.server()),
    verify(request: Parameters<LiveQueryVerifier["verify"]>[0]) {
      const owned = { ...request };
      return database.use((database) => database.liveVerifier.verify(owned));
    },
    close: () => database.close(),
  });
}
/** Lazy non-executing structured EXPLAIN service with transient planning samples. */
export function createNodeDuckDBPlanInspector(options: NodeDuckDBOptions = {}): QueryPlanInspector {
  const database = lazyDatabase(options);
  return Object.freeze({
    dialect: "duckdb",
    adapterVersion: DUCKDB_DIALECT_VERSION,
    parameterMode: "samples-required",
    environment: () => database.use((database) => database.planInspector.environment()),
    capture(request: Parameters<QueryPlanInspector["capture"]>[0]) {
      let owned: typeof request;
      try {
        owned = { ...request, ...(request.values === undefined ? {} : { values: structuredClone(request.values) }) };
      } catch {
        return Promise.reject(new TypeError("DuckDB planning samples must be cloneable application values"));
      }
      return database.use((database) => database.planInspector.capture(owned));
    },
    close: () => database.close(),
  });
}
