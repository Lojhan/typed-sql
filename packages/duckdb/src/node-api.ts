import type * as NativeSDK from "@duckdb/node-api";
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
import { duckDBVersionSupport } from "./support.js";
export type DuckDBSDK = typeof NativeSDK;
export type DuckDBSDKImporter = () => Promise<DuckDBSDK>;
const packageName = "@duckdb/node-api";
const loadSDK: DuckDBSDKImporter = async () => import(packageName) as Promise<DuckDBSDK>;
export interface NodeDuckDBOptions extends Omit<DuckDBDatabaseOptions, "connection"> {
  readonly connection?: NativeSDK.DuckDBConnection;
  readonly instance?: NativeSDK.DuckDBInstance;
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
export function duckDBTypeFromSDK(type: NativeSDK.DuckDBType, sdk: DuckDBSDK): DuckDBType {
  const id = sdk.DuckDBTypeId;
  switch (type.typeId) {
    case id.DECIMAL: {
      const value = type as NativeSDK.DuckDBDecimalType;
      return { kind: "scalar", name: "DECIMAL", precision: value.width, scale: value.scale };
    }
    case id.LIST:
      return { kind: "list", element: duckDBTypeFromSDK((type as NativeSDK.DuckDBListType).valueType, sdk) };
    case id.ARRAY: {
      const value = type as NativeSDK.DuckDBArrayType;
      return { kind: "array", element: duckDBTypeFromSDK(value.valueType, sdk), length: value.length };
    }
    case id.STRUCT: {
      const value = type as NativeSDK.DuckDBStructType;
      return value.entryNames.length > 0 && value.entryNames.every((name) => name === "")
        ? { kind: "tuple", elements: value.entryTypes.map((item) => duckDBTypeFromSDK(item, sdk)) }
        : {
            kind: "struct",
            fields: value.entryNames.map((name, i) => ({ name, type: duckDBTypeFromSDK(value.entryTypes[i]!, sdk) })),
          };
    }
    case id.UNION: {
      const value = type as NativeSDK.DuckDBUnionType;
      return {
        kind: "union",
        fields: value.memberTags.map((name, i) => ({ name, type: duckDBTypeFromSDK(value.memberTypes[i]!, sdk) })),
      };
    }
    case id.MAP: {
      const value = type as NativeSDK.DuckDBMapType;
      return {
        kind: "map",
        key: duckDBTypeFromSDK(value.keyType, sdk),
        value: duckDBTypeFromSDK(value.valueType, sdk),
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
function sdkType(type: DuckDBType, sdk: DuckDBSDK): NativeSDK.DuckDBType {
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
function nativeValue(binding: DuckDBBinding, sdk: DuckDBSDK): NativeSDK.DuckDBValue {
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
export function adaptDuckDBConnection(connection: NativeSDK.DuckDBConnection, sdk: DuckDBSDK): DuckDBConnectionLike {
  if (!(connection instanceof sdk.DuckDBConnection))
    throw new TypeError("DuckDB connection and sdkImporter must belong to the same SDK module");
  const libraryVersion = sdk.version();
  if (duckDBVersionSupport(libraryVersion) !== "supported")
    throw new TypeError("DuckDB SDK engine is outside the qualified version policy");
  return Object.freeze({
    identity: connection,
    libraryVersion,
    interrupt: () => connection.interrupt(),
    close: () => connection.closeSync(),
    async prepare(text: string): Promise<DuckDBNativeStatement> {
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
      return Object.freeze({
        async close() {
          if (closed) return;
          closed = true;
          native.destroySync();
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
          const command = result.returnType !== sdk.ResultReturnType.QUERY_RESULT,
            columns = command
              ? []
              : Array.from({ length: result.columnCount }, (_, i) => ({
                  name: result.columnName(i),
                  type: duckDBTypeFromSDK(result.columnType(i), sdk),
                }));
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
              result.closeSync();
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
  const sdk = await (options.sdkImporter ?? loadSDK)();
  if (options.instance && !(options.instance instanceof sdk.DuckDBInstance))
    throw new TypeError("DuckDB instance and sdkImporter must belong to the same SDK module");
  let instance = options.instance,
    connection = options.connection,
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
        base.close?.();
        if (ownsInstance) instance?.closeSync();
      },
    };
    return createDuckDBDatabase({
      connection: adapted,
      ownsConnection,
      ...(options.typePolicy ? { typePolicy: options.typePolicy } : {}),
      ...(options.observer ? { observer: options.observer } : {}),
      ...(options.preparedCardinalityVariantLimit === undefined
        ? {}
        : { preparedCardinalityVariantLimit: options.preparedCardinalityVariantLimit }),
    });
  } catch (error) {
    if (createdConnection) connection?.closeSync();
    if (createdInstance) instance?.closeSync();
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
