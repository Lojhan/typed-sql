import { performance } from "node:perf_hooks";
import { sql } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import {
  compileMySqlRowDecoders,
  decodeMySqlRow,
  MySqlDecoderPlanCache,
  type MySqlFieldLike,
  type MySqlRuntimeTypePolicy,
} from "../src/decoding.js";
import {
  createMySqlDatabase,
  type MySqlConnectionLike,
  type MySqlExecutionResult,
  type MySqlPoolLike,
  type MySqlProtocolStream,
} from "../src/runtime.js";

const defaultPolicy: MySqlRuntimeTypePolicy = {
  bigint: "bigint",
  decimal: "string",
  date: "Date",
  json: "unknown",
  tinyint1: "boolean",
};

function decodedValue(plan: ReturnType<MySqlDecoderPlanCache["get"]>, value: unknown): unknown {
  return decodeMySqlRow({ value }, plan).value;
}

class ResultStream implements MySqlProtocolStream {
  readonly connectionReusable = true;
  readonly fields: Promise<readonly MySqlFieldLike[]>;
  #row: Record<string, unknown> | undefined;

  constructor(fields: readonly MySqlFieldLike[], row: Record<string, unknown>) {
    this.fields = Promise.resolve(fields);
    this.#row = row;
  }

  [Symbol.asyncIterator](): MySqlProtocolStream {
    return this;
  }

  next(): Promise<IteratorResult<Record<string, unknown>>> {
    const row = this.#row;
    this.#row = undefined;
    return Promise.resolve(row === undefined ? { done: true, value: undefined } : { done: false, value: row });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class CacheConnection implements MySqlConnectionLike {
  readonly streams: { readonly fields: readonly MySqlFieldLike[]; readonly row: Record<string, unknown> }[] = [];
  releaseCount = 0;

  execute(): Promise<MySqlExecutionResult> {
    throw new Error("buffered cache test executes through the pool");
  }

  stream(): MySqlProtocolStream {
    const source = this.streams.shift();
    if (source === undefined) throw new Error("missing stream fixture");
    return new ResultStream(source.fields, source.row);
  }

  query(): Promise<MySqlExecutionResult> {
    return Promise.resolve({ rows: [] });
  }

  beginTransaction(): Promise<void> {
    return Promise.resolve();
  }

  commit(): Promise<void> {
    return Promise.resolve();
  }

  rollback(): Promise<void> {
    return Promise.resolve();
  }

  release(): void {
    this.releaseCount += 1;
  }
}

class CachePool implements MySqlPoolLike {
  readonly connection = new CacheConnection();
  bufferedResult: MySqlExecutionResult = {
    rows: [{ value: "41" }],
    fields: [{ name: "value", columnType: 8 }],
  };

  execute(): Promise<MySqlExecutionResult> {
    return Promise.resolve(this.bufferedResult);
  }

  getConnection(): Promise<MySqlConnectionLike> {
    return Promise.resolve(this.connection);
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

await describe("MySQL decoder plan cache", async () => {
  await it("hits across metadata identities and misses when an existing identity mutates", () => {
    const cache = new MySqlDecoderPlanCache(defaultPolicy);
    const mutableField = { name: "value", columnType: 8 };
    const fields: MySqlFieldLike[] = [mutableField];
    const bigintPlan = cache.get(fields);
    strict.strictEqual(cache.get(fields), bigintPlan);
    strict.strictEqual(cache.get([{ name: "value", columnType: 8 }]), bigintPlan);
    strict.strictEqual(decodedValue(bigintPlan, "42"), 42n);

    mutableField.columnType = 245;
    const jsonPlan = cache.get(fields);
    strict.notStrictEqual(jsonPlan, bigintPlan);
    strict.strictEqual(decodedValue(jsonPlan, "42"), "42");

    const tinyintPlan = cache.get([{ name: "value", columnType: 1, columnLength: 1 }]);
    const ordinaryTinyintPlan = cache.get([{ name: "value", columnType: 1, columnLength: 4 }]);
    strict.notStrictEqual(tinyintPlan, ordinaryTinyintPlan);
    strict.strictEqual(decodedValue(tinyintPlan, "1"), true);
    strict.strictEqual(decodedValue(ordinaryTinyintPlan, "1"), "1");
    strict.notStrictEqual(cache.get([{ name: "Value", columnType: 8 }]), bigintPlan);
    strict.notStrictEqual(cache.get([{ name: "vague", columnType: 8 }]), bigintPlan);

    const duplicateJsonFirst = cache.get([
      { name: "value", columnType: 245 },
      { name: "value", columnType: 8 },
    ]);
    const duplicateBigintFirst = cache.get([
      { name: "value", columnType: 8 },
      { name: "value", columnType: 245 },
    ]);
    strict.notStrictEqual(duplicateJsonFirst, duplicateBigintFirst);
    strict.strictEqual(decodedValue(duplicateJsonFirst, "42"), "42");
    strict.strictEqual(decodedValue(duplicateBigintFirst, "42"), 42n);
  });

  await it("isolates type policies and decimal codec closures", () => {
    const bigint = new MySqlDecoderPlanCache(defaultPolicy);
    const string = new MySqlDecoderPlanCache({ ...defaultPolicy, bigint: "string" });
    const fields = [{ name: "value", columnType: 8 }];
    strict.strictEqual(decodedValue(bigint.get(fields), "42"), 42n);
    strict.strictEqual(decodedValue(string.get(fields), 42n), "42");

    const firstDecimal = new MySqlDecoderPlanCache({ ...defaultPolicy, decimal: "Decimal" }, (value) => ({
      codec: "first",
      value,
    }));
    const secondDecimal = new MySqlDecoderPlanCache({ ...defaultPolicy, decimal: "Decimal" }, (value) => ({
      codec: "second",
      value,
    }));
    const decimalFields = [{ name: "value", columnType: 246 }];
    strict.deepStrictEqual(decodedValue(firstDecimal.get(decimalFields), "12.50"), {
      codec: "first",
      value: "12.50",
    });
    strict.deepStrictEqual(decodedValue(secondDecimal.get(decimalFields), "12.50"), {
      codec: "second",
      value: "12.50",
    });
  });

  await it("uses bounded least-recently-used storage", () => {
    const cache = new MySqlDecoderPlanCache(defaultPolicy, undefined, 2);
    const firstFields = [{ name: "first", columnType: 8 }];
    const secondFields = [{ name: "second", columnType: 8 }];
    const thirdFields = [{ name: "third", columnType: 8 }];
    const first = cache.get(firstFields);
    const second = cache.get(secondFields);
    strict.strictEqual(cache.get(firstFields), first);
    cache.get(thirdFields);
    strict.strictEqual(cache.get(firstFields), first);
    strict.notStrictEqual(cache.get(secondFields), second);
    strict.throws(() => new MySqlDecoderPlanCache(defaultPolicy, undefined, 0), /positive safe integer/);
  });

  await it("shares stable prepared metadata across buffered and streamed execution without stale plans", async () => {
    const pool = new CachePool();
    const database = createMySqlDatabase({ pool, typePolicy: { ...defaultPolicy, json: "string" } });
    const prepared = database.prepare("cached-value", () => sql<{ value: unknown }>`SELECT cached_value`);

    strict.deepStrictEqual(await database.execute(prepared()), [{ value: 41n }]);
    pool.connection.streams.push(
      { fields: [{ name: "value", columnType: 8 }], row: { value: "42" } },
      { fields: [{ name: "value", columnType: 245 }], row: { value: { current: true } } },
    );
    const stableMetadata = database.stream(prepared());
    strict.deepStrictEqual(await stableMetadata.next(), { done: false, value: { value: 42n } });
    await stableMetadata.close();

    const changedMetadata = database.stream(prepared());
    strict.deepStrictEqual(await changedMetadata.next(), {
      done: false,
      value: { value: '{"current":true}' },
    });
    await changedMetadata.close();
    strict.strictEqual(pool.connection.releaseCount, 2);
  });

  await it("keeps repeated decoder lookup faster than recompiling stable metadata", () => {
    const fields = Array.from(
      { length: 24 },
      (_, index): MySqlFieldLike => ({
        name: `column_${index}`,
        columnType: index % 2 === 0 ? 8 : 246,
      }),
    );
    const cache = new MySqlDecoderPlanCache(defaultPolicy);
    cache.get(fields);
    const iterations = 10_000;
    for (let index = 0; index < 2_000; index += 1) {
      compileMySqlRowDecoders(fields, defaultPolicy);
      cache.get(fields);
    }
    const uncachedSamples: number[] = [];
    const cachedSamples: number[] = [];
    for (let sample = 0; sample < 5; sample += 1) {
      let start = performance.now();
      for (let index = 0; index < iterations; index += 1) compileMySqlRowDecoders(fields, defaultPolicy);
      uncachedSamples.push(performance.now() - start);
      start = performance.now();
      for (let index = 0; index < iterations; index += 1) cache.get(fields);
      cachedSamples.push(performance.now() - start);
    }
    uncachedSamples.sort((left, right) => left - right);
    cachedSamples.sort((left, right) => left - right);
    const uncachedDuration = uncachedSamples[2]!;
    const cachedDuration = cachedSamples[2]!;

    strict.ok(
      cachedDuration < uncachedDuration * 0.8,
      `Expected cached decoder lookup (${cachedDuration.toFixed(2)}ms) to stay at least 20% below recompilation (${uncachedDuration.toFixed(2)}ms)`,
    );
  });
});
