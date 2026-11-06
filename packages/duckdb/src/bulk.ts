import {
  defineAdapterCapability,
  type ExecutionOptions,
  executionDeadline,
  type Query,
  QueryCancelledError,
} from "@typed-sql/core";
import { parseDuckDBStatement } from "./parser/parser.js";
import type { DuckDBBinding } from "./runtime.js";
export interface DuckDBAppenderProgress {
  readonly rows: number;
  readonly chunks: number;
}
export interface DuckDBAppendOptions extends ExecutionOptions {
  /** Native vector chunks contain at most 2048 rows. */
  readonly chunkRows?: number;
  readonly onProgress?: (progress: DuckDBAppenderProgress) => void;
}
export interface DuckDBAppenderCapability {
  append<Input, Row, Params extends readonly unknown[]>(
    rowQuery: (input: Input) => Query<Row, Params>,
    rows: Iterable<Input> | AsyncIterable<Input>,
    options?: DuckDBAppendOptions,
  ): Promise<DuckDBAppenderProgress>;
}
export const duckdbAppender = defineAdapterCapability<DuckDBAppenderCapability>("duckdb.appender");
export interface DuckDBAppendTarget {
  readonly table: readonly string[];
  readonly columns: readonly string[];
}
export interface DuckDBAppendRow {
  readonly text: string;
  readonly bindings: readonly DuckDBBinding[];
}
export interface DuckDBAppenderTransport {
  transfer(
    target: DuckDBAppendTarget,
    statement: DuckDBAppendRow,
    chunks: AsyncIterable<readonly (readonly DuckDBBinding[])[]>,
    options: DuckDBAppendOptions,
  ): Promise<void>;
  prepare(query: Query<unknown>): DuckDBAppendRow;
}
function target(text: string, count: number): DuckDBAppendTarget {
  const parsed = parseDuckDBStatement(text),
    values = parsed.values?.[0];
  if (
    parsed.kind !== "insert" ||
    parsed.ctes.length ||
    parsed.source ||
    parsed.conflict ||
    parsed.returning?.length ||
    parsed.byName ||
    parsed.relations.length ||
    !parsed.target ||
    !parsed.columns?.length ||
    parsed.values?.length !== 1 ||
    values?.length !== count ||
    count !== parsed.columns.length ||
    new Set(parsed.columns.map((name) => name.toLowerCase())).size !== count ||
    values.some((value, i) => value.kind !== "parameter" || Number(value.value) !== i + 1)
  )
    throw new TypeError(
      "DuckDB appender requires one plain INSERT with explicit columns and one ordered parameter per column; no RETURNING, conflict clause, CTE or query source",
    );
  return { table: parsed.target, columns: parsed.columns };
}
export function createDuckDBAppenderCapability(transport: DuckDBAppenderTransport): DuckDBAppenderCapability {
  return Object.freeze({
    async append<Input, Row, Params extends readonly unknown[]>(
      rowQuery: (input: Input) => Query<Row, Params>,
      rows: Iterable<Input> | AsyncIterable<Input>,
      options: DuckDBAppendOptions = {},
    ): Promise<DuckDBAppenderProgress> {
      const chunkRows = options.chunkRows ?? 2048;
      if (!Number.isSafeInteger(chunkRows) || chunkRows < 1 || chunkRows > 2048)
        throw new RangeError("DuckDB appender chunkRows must be 1–2048");
      const deadline = executionDeadline(options);
      const check = () => {
        if (options.signal?.aborted) throw new QueryCancelledError("signal", { cause: options.signal.reason });
        if (deadline !== undefined && Date.now() >= deadline) throw new QueryCancelledError("deadline");
      };
      check();
      let progress = { rows: 0, chunks: 0 };
      // for-await closes the source on encoding, structural, native, or cancellation failures.
      const iterator = (async function* () {
        for await (const row of rows) yield row;
      })();
      let first: IteratorResult<Input>;
      try {
        first = await iterator.next();
        check();
        if (first.done) {
          return Object.freeze(progress);
        }
        const initial = transport.prepare(rowQuery(first.value) as unknown as Query<unknown>),
          destination = target(initial.text, initial.bindings.length);
        let consumed = false;
        const chunks = (async function* () {
          let current: IteratorResult<Input> = first;
          let pending: (readonly DuckDBBinding[])[] = [];
          while (!current.done) {
            check();
            const row =
              progress.rows === 0 ? initial : transport.prepare(rowQuery(current.value) as unknown as Query<unknown>);
            if (
              row.text !== initial.text ||
              row.bindings.length !== initial.bindings.length ||
              row.bindings.some(
                (binding, i) => JSON.stringify(binding.type) !== JSON.stringify(initial.bindings[i]!.type),
              )
            )
              throw new TypeError("DuckDB appender row query changed its structural SQL shape or physical targets");
            pending.push(row.bindings);
            progress = { rows: progress.rows + 1, chunks: progress.chunks };
            if (pending.length === chunkRows) {
              yield pending;
              pending = [];
              progress = { ...progress, chunks: progress.chunks + 1 };
              options.onProgress?.(Object.freeze({ ...progress }));
            }
            current = await iterator.next();
          }
          consumed = true;
          if (pending.length) {
            yield pending;
            progress = { ...progress, chunks: progress.chunks + 1 };
            options.onProgress?.(Object.freeze({ ...progress }));
          }
        })();
        await transport.transfer(destination, initial, chunks, options);
        if (!consumed) throw new Error("DuckDB appender did not consume its row source");
        return Object.freeze(progress);
      } finally {
        // Iteration already propagates normal producer finalization failures. If transfer
        // stops early, retire the source while preserving the original failure.
        await iterator.return(undefined).catch(() => undefined);
      }
    },
  });
}
