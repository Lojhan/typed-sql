import { adapterCapabilities, createAdapterCapabilityResolver, defineAdapterCapability } from "@typed-sql/core";
import { assertSafeNumbers, type BatchDatabase, type BufferedOptions, createBufferedDatabase } from "./index.js";
import { sqliteWireOptions } from "./sqlite-values.js";

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all(): Promise<{ readonly results?: readonly unknown[]; readonly success: boolean; readonly error?: string }>;
}
export interface D1SessionBinding {
  prepare(text: string): D1Statement;
  batch(
    statements: D1Statement[],
  ): Promise<readonly { readonly results?: readonly unknown[]; readonly success: boolean; readonly error?: string }[]>;
  getBookmark(): string | null;
}
export interface D1Binding extends Omit<D1SessionBinding, "getBookmark"> {
  withSession(constraintOrBookmark?: string): D1SessionBinding;
}
export const d1Sessions = defineAdapterCapability<{ withSession(constraintOrBookmark?: string): D1SessionDatabase }>(
  "cloudflare.d1.sessions",
);
export interface D1SessionDatabase extends BatchDatabase {
  getBookmark(): string | null;
}

function rows(result: Awaited<ReturnType<D1Statement["all"]>>): readonly unknown[] {
  if (!result.success) throw new Error(result.error ?? "D1 statement failed");
  return (result.results ?? []).map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row))
      throw new TypeError("D1 returned a non-object row");
    assertSafeNumbers(Object.values(row));
    return Object.fromEntries(
      Object.entries(row).map(([name, value]) => {
        if (value instanceof ArrayBuffer) return [name, new Uint8Array(value)];
        if (Array.isArray(value)) {
          if (!value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255))
            throw new TypeError("D1 returned invalid BLOB bytes");
          return [name, Uint8Array.from(value)];
        }
        return [name, value];
      }),
    );
  });
}

function createSession(binding: Pick<D1SessionBinding, "prepare" | "batch">, options: BufferedOptions): BatchDatabase {
  if (
    options.profile.jsonWire !== "text" ||
    (options.profile.jsonInputWire !== undefined && options.profile.jsonInputWire !== "text")
  )
    throw new TypeError("D1 requires text JSON wire formats");
  if (!options.profile.typePolicyHash)
    throw new TypeError("D1 requires the compiled typePolicyHash in its transport profile");
  if (options.profile.integer !== "safe-number" || options.profile.dialect !== "sqlite")
    throw new TypeError("D1 requires a SQLite safe-number transport profile");
  const prepare = (text: string, values: readonly unknown[]) => {
    assertSafeNumbers(values);
    return binding.prepare(text).bind(...values);
  };
  return createBufferedDatabase(
    {
      async execute(text, values) {
        return rows(await prepare(text, values).all());
      },
      async batch(statements) {
        return (await binding.batch(statements.map(({ text, values }) => prepare(text, values)))).map(rows);
      },
    },
    sqliteWireOptions(options, true),
  );
}

export function createD1Database(
  binding: D1Binding,
  options: BufferedOptions,
): BatchDatabase & {
  readonly [adapterCapabilities]: ReturnType<typeof createAdapterCapabilityResolver>;
} {
  const service = Object.freeze({
    withSession(constraintOrBookmark?: string): D1SessionDatabase {
      const session = binding.withSession(constraintOrBookmark);
      return Object.freeze({ ...createSession(session, options), getBookmark: () => session.getBookmark() });
    },
  });
  return Object.freeze({
    ...createSession(binding, options),
    [adapterCapabilities]: createAdapterCapabilityResolver([[d1Sessions, service]]),
  });
}
