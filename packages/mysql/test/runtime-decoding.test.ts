import { describe, it, strict } from "poku";
import { sql } from "../../core/src/index.js";
import {
  createMySqlDatabase,
  type MySqlConnectionLike,
  type MySqlExecutionResult,
  type MySqlPoolLike,
} from "../src/runtime.js";

class ResultPool implements MySqlPoolLike {
  constructor(readonly result: MySqlExecutionResult) {}

  async execute(): Promise<MySqlExecutionResult> {
    return this.result;
  }

  async getConnection(): Promise<MySqlConnectionLike> {
    throw new Error("not used by decoding tests");
  }

  async end(): Promise<void> {}
}

async function decode<Row extends Record<string, unknown>>(
  result: MySqlExecutionResult,
  options: Omit<Parameters<typeof createMySqlDatabase>[0], "pool"> = {},
): Promise<readonly Row[]> {
  return createMySqlDatabase({ pool: new ResultPool(result), ...options }).execute(sql<Row>`SELECT values`);
}

await describe("MySQL buffered row decoding", async () => {
  await it("returns the driver result by identity when metadata requires no decoding", async () => {
    const profile = { plan: "pro" };
    const row = { profile, ordinary_tinyint: 1, unknown_type: "unchanged" };
    const rows = [row];
    const decoded = await decode({
      rows,
      fields: [
        { name: "unknown_type", columnType: 999 },
        { name: "profile", columnType: 245 },
        { name: "ordinary_tinyint", columnType: 1, columnLength: 4 },
      ],
    });
    strict.strictEqual(decoded, rows);
    strict.strictEqual(decoded[0], row);
    strict.strictEqual(decoded[0]?.profile, profile);

    const withoutMetadata = [{ id: "42" }];
    strict.strictEqual(await decode({ rows: withoutMetadata }), withoutMetadata);
  });

  await it("uses reordered metadata, ignores missing metadata, and only copies changed rows", async () => {
    const nested = { stable: true };
    const changedRow = { id: "42", already: 7n, untyped: "preserved", nested };
    const stableRow = { id: 8n, already: 9n, untyped: "also preserved", nested };
    const rows = [changedRow, stableRow];
    const decoded = await decode<{
      id: bigint;
      already: bigint;
      untyped: string;
      nested: { stable: boolean };
    }>({
      rows,
      fields: [
        { name: "ghost", columnType: 8 },
        { name: "already", columnType: 8 },
        { name: "id", columnType: 8 },
      ],
    });
    strict.notStrictEqual(decoded, rows);
    strict.notStrictEqual(decoded[0], changedRow);
    strict.strictEqual(decoded[1], stableRow);
    strict.strictEqual(decoded[0]?.id, 42n);
    strict.strictEqual(decoded[0]?.already, 7n);
    strict.strictEqual(decoded[0]?.untyped, "preserved");
    strict.strictEqual(decoded[0]?.nested, nested);
  });

  await it("applies every scalar policy codec", async () => {
    const date = new Date("2026-01-02T03:04:05Z");
    const numbers = await decode<{
      id: number;
      budget: number;
      created_at: string;
      profile: string;
      yes_number: boolean;
      yes_string: boolean;
      yes_boolean: boolean;
      no: boolean;
    }>(
      {
        rows: [
          {
            id: "42",
            budget: "12.50",
            created_at: date,
            profile: { plan: "pro" },
            yes_number: 1,
            yes_string: "1",
            yes_boolean: true,
            no: 0,
          },
        ],
        fields: [
          { name: "id", columnType: 8 },
          { name: "budget", columnType: 246 },
          { name: "created_at", columnType: 7 },
          { name: "profile", columnType: 245 },
          { name: "yes_number", columnType: 1, columnLength: 1 },
          { name: "yes_string", columnType: 1, columnLength: 1 },
          { name: "yes_boolean", columnType: 1, columnLength: 1 },
          { name: "no", columnType: 1, columnLength: 1 },
        ],
      },
      {
        typePolicy: {
          bigint: "number",
          decimal: "number",
          date: "string",
          json: "string",
          tinyint1: "boolean",
        },
      },
    );
    strict.deepStrictEqual(numbers, [
      {
        id: 42,
        budget: 12.5,
        created_at: String(date),
        profile: '{"plan":"pro"}',
        yes_number: true,
        yes_string: true,
        yes_boolean: true,
        no: false,
      },
    ]);

    const strings = await decode<{ id: string; budget: string; created_at: Date; active: number }>(
      {
        rows: [{ id: 42, budget: 12.5, created_at: "2026-01-02T03:04:05Z", active: 1 }],
        fields: [
          { name: "active", columnType: 1, columnLength: 1 },
          { name: "created_at", columnType: 12 },
          { name: "budget", columnType: 246 },
          { name: "id", columnType: 8 },
        ],
      },
      {
        typePolicy: {
          bigint: "string",
          decimal: "string",
          date: "Date",
          json: "JsonValue",
          tinyint1: "number",
        },
      },
    );
    strict.strictEqual(strings[0]?.id, "42");
    strict.strictEqual(strings[0]?.budget, "12.5");
    strict.ok(strings[0]?.created_at instanceof Date);
    strict.strictEqual(strings[0]?.active, 1);

    const decimals = await decode<{ budget: { readonly source: string } }>(
      { rows: [{ budget: "98.76" }], fields: [{ name: "budget", columnType: 246 }] },
      {
        typePolicy: {
          bigint: "bigint",
          decimal: "Decimal",
          date: "Date",
          json: "unknown",
          tinyint1: "boolean",
        },
        decimal: (source) => ({ source }),
      },
    );
    strict.deepStrictEqual(decimals, [{ budget: { source: "98.76" } }]);
  });

  await it("preserves nullish values and their row identities across active decoders", async () => {
    const nulls = {
      id: null,
      budget: undefined,
      created_at: null,
      profile: undefined,
      active: null,
    };
    const rows = [nulls];
    const decoded = await decode({
      rows,
      fields: [
        { name: "id", columnType: 8 },
        { name: "budget", columnType: 246 },
        { name: "created_at", columnType: 10 },
        { name: "profile", columnType: 245 },
        { name: "active", columnType: 1, columnLength: 1 },
      ],
    });
    strict.strictEqual(decoded, rows);
    strict.strictEqual(decoded[0], nulls);
  });

  await it("decodes wide rows in metadata-independent linear passes", async () => {
    const width = 128;
    const row: Record<string, unknown> = { passthrough: "kept" };
    const fields = [];
    for (let index = 0; index < width; index += 1) {
      row[`column_${index}`] = String(index);
      fields.push({ name: `column_${index}`, columnType: 8 });
    }
    fields.reverse();
    const decoded = await decode<Record<string, bigint | string>>({ rows: [row], fields });
    strict.strictEqual(decoded[0]?.passthrough, "kept");
    for (let index = 0; index < width; index += 1) strict.strictEqual(decoded[0]?.[`column_${index}`], BigInt(index));
  });

  await it("decodes special and case-sensitive aliases without changing object prototypes", async () => {
    const row = Object.fromEntries([
      ["__proto__", "1"],
      ["constructor", "2"],
      ["0", "3"],
      ["Value", "4"],
      ["value", "5"],
    ]);
    const decoded = await decode<Record<string, bigint>>({
      rows: [row],
      fields: [
        { name: "value", columnType: 8 },
        { name: "Value", columnType: 8 },
        { name: "0", columnType: 8 },
        { name: "constructor", columnType: 8 },
        { name: "__proto__", columnType: 8 },
      ],
    });
    strict.strictEqual(Object.getPrototypeOf(decoded[0]), Object.prototype);
    strict.strictEqual(Object.hasOwn(decoded[0]!, "__proto__"), true);
    strict.deepStrictEqual(decoded[0], {
      "0": 3n,
      ["__proto__"]: 1n,
      constructor: 2n,
      Value: 4n,
      value: 5n,
    });
  });

  await it("preserves the first metadata entry for duplicate field names", async () => {
    const row = { value: "42" };
    const rows = [row];
    const decoded = await decode({
      rows,
      fields: [
        { name: "value", columnType: 245 },
        { name: "value", columnType: 8 },
      ],
    });
    strict.strictEqual(decoded, rows);
    strict.strictEqual(decoded[0]?.value, "42");
  });
});
