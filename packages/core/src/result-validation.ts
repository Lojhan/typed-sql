import type { QueryStream } from "./execution.js";
import type { Query } from "./query.js";

/** Structural Standard Typed V1 contract, copied from the dependency-free specification. */
export interface StandardTypedV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardTypedV1.Props<Input, Output>;
}

export namespace StandardTypedV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: Types<Input, Output>;
  }

  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }

  export type InferInput<Schema extends StandardTypedV1> = NonNullable<Schema["~standard"]["types"]>["input"];
  export type InferOutput<Schema extends StandardTypedV1> = NonNullable<Schema["~standard"]["types"]>["output"];
}

/** Dependency-free Standard Schema V1 contract implemented by ecosystem validators. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

export namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> extends StandardTypedV1.Props<Input, Output> {
    readonly validate: (value: unknown, options?: Options) => Result<Output> | Promise<Result<Output>>;
  }

  export interface Options {
    readonly libraryOptions?: Record<string, unknown>;
  }

  export type Result<Output> = SuccessResult<Output> | FailureResult;

  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }

  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }

  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment>;
  }

  export interface PathSegment {
    readonly key: PropertyKey;
  }

  export interface Types<Input = unknown, Output = Input> extends StandardTypedV1.Types<Input, Output> {}

  export type InferInput<Schema extends StandardTypedV1> = StandardTypedV1.InferInput<Schema>;
  export type InferOutput<Schema extends StandardTypedV1> = StandardTypedV1.InferOutput<Schema>;
}

type IsAny<Value> = 0 extends 1 & Value ? true : false;

/** A validator is compatible only when its non-`any` output is assignable to the inferred row. */
export type CompatibleResultSchema<Row, Schema extends StandardSchemaV1> =
  IsAny<StandardSchemaV1.InferOutput<Schema>> extends true
    ? never
    : [StandardSchemaV1.InferOutput<Schema>] extends [Row]
      ? Schema
      : never;

export interface QueryResultValidationOptions {
  /** Vendor messages may echo values, so they are excluded unless explicitly requested. */
  readonly includeIssueMessages?: boolean;
  readonly libraryOptions?: Record<string, unknown>;
}

export interface QueryResultValidationIssue {
  readonly path: readonly PropertyKey[];
  readonly message?: string;
}

export type QueryResultValidationFailure = "issues" | "validator-exception" | "invalid-result";

export class QueryResultValidationError extends Error {
  readonly code = "TSQL_RESULT_VALIDATION";
  readonly fingerprint: string;
  readonly rowIndex: number;
  readonly vendor: string;
  readonly failure: QueryResultValidationFailure;
  readonly issues: readonly QueryResultValidationIssue[];

  constructor(options: {
    readonly fingerprint: string;
    readonly rowIndex: number;
    readonly vendor: string;
    readonly failure: QueryResultValidationFailure;
    readonly issues: readonly QueryResultValidationIssue[];
  }) {
    const locations = options.issues
      .map(({ path }) => path.map(String).join("."))
      .filter(Boolean)
      .join(", ");
    super(
      `Query result validation failed for ${options.fingerprint} at row ${options.rowIndex}${
        locations.length === 0 ? "" : ` (${locations})`
      }`,
    );
    this.name = "QueryResultValidationError";
    this.fingerprint = options.fingerprint;
    this.rowIndex = options.rowIndex;
    this.vendor = options.vendor;
    this.failure = options.failure;
    this.issues = options.issues;
  }
}

interface ValidatorBinding {
  readonly source: object;
  readonly schema: StandardSchemaV1;
  readonly options: QueryResultValidationOptions;
}

const validators = new WeakMap<object, ValidatorBinding>();
const emptyIssues = Object.freeze([]);

/** @internal Used by `sql.validateResult()` after it creates a separate immutable query. */
export function setQueryResultValidator(
  query: object,
  source: object,
  schema: StandardSchemaV1,
  options: QueryResultValidationOptions,
): void {
  validators.set(query, Object.freeze({ source, schema, options: Object.freeze({ ...options }) }));
}

export function hasQueryResultValidator(query: object): boolean {
  return validators.has(query);
}

/** Returns the original query identity so adapter-owned metadata survives validation attachment. */
export function queryResultValidationSource<Row, Params extends readonly unknown[]>(
  query: Query<Row, Params>,
): Query<unknown, Params> {
  return (validators.get(query)?.source ?? query) as Query<unknown, Params>;
}

function normalizePath(path: StandardSchemaV1.Issue["path"]): readonly PropertyKey[] {
  if (path === undefined) return emptyIssues;
  const normalized: PropertyKey[] = [];
  for (const segment of path) {
    normalized.push(typeof segment === "object" && segment !== null ? segment.key : segment);
  }
  return Object.freeze(normalized);
}

function normalizeIssues(
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
  messages: boolean,
): readonly QueryResultValidationIssue[] {
  const normalized: QueryResultValidationIssue[] = [];
  // Do not call Array methods: Standard Schema implementations may return richer array subclasses.
  for (const issue of issues) {
    normalized.push(
      Object.freeze({ path: normalizePath(issue.path), ...(messages ? { message: String(issue.message) } : {}) }),
    );
  }
  return Object.freeze(normalized);
}

async function validateValue<Row>(
  binding: ValidatorBinding,
  value: unknown,
  fingerprint: string,
  rowIndex: number,
): Promise<Row> {
  const standard = binding.schema["~standard"];
  let result: StandardSchemaV1.Result<unknown>;
  try {
    result = await standard.validate(
      value,
      binding.options.libraryOptions === undefined ? undefined : { libraryOptions: binding.options.libraryOptions },
    );
  } catch (error) {
    const issues =
      binding.options.includeIssueMessages === true && error instanceof Error
        ? Object.freeze([Object.freeze({ path: emptyIssues, message: error.message })])
        : emptyIssues;
    throw new QueryResultValidationError({
      fingerprint,
      rowIndex,
      vendor: standard.vendor,
      failure: "validator-exception",
      issues,
    });
  }
  if (typeof result !== "object" || result === null) {
    throw new QueryResultValidationError({
      fingerprint,
      rowIndex,
      vendor: standard.vendor,
      failure: "invalid-result",
      issues: emptyIssues,
    });
  }
  if (result.issues) {
    let issues: readonly QueryResultValidationIssue[];
    try {
      issues = normalizeIssues(result.issues, binding.options.includeIssueMessages === true);
    } catch {
      throw new QueryResultValidationError({
        fingerprint,
        rowIndex,
        vendor: standard.vendor,
        failure: "invalid-result",
        issues: emptyIssues,
      });
    }
    throw new QueryResultValidationError({
      fingerprint,
      rowIndex,
      vendor: standard.vendor,
      failure: "issues",
      issues,
    });
  }
  if (!("value" in result)) {
    throw new QueryResultValidationError({
      fingerprint,
      rowIndex,
      vendor: standard.vendor,
      failure: "invalid-result",
      issues: emptyIssues,
    });
  }
  return result.value as Row;
}

export async function validateQueryResultRows<Row, Params extends readonly unknown[]>(
  query: Query<Row, Params>,
  rows: readonly unknown[],
  fingerprint: string,
): Promise<readonly Row[]> {
  const binding = validators.get(query);
  if (binding === undefined) return rows as readonly Row[];
  const validated: Row[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    validated.push(await validateValue<Row>(binding, rows[index], fingerprint, index));
  }
  return Object.freeze(validated);
}

export function validateQueryResultStream<Row, Params extends readonly unknown[]>(
  query: Query<Row, Params>,
  stream: QueryStream<unknown>,
  fingerprint: string,
): QueryStream<Row> {
  const binding = validators.get(query);
  if (binding === undefined) return stream as QueryStream<Row>;
  let rowIndex = 0;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await stream.close();
  };
  const validated: QueryStream<Row> = {
    [Symbol.asyncIterator]: () => validated,
    async next() {
      if (closed) return { done: true, value: undefined };
      const result = await stream.next();
      if (result.done) {
        closed = true;
        return { done: true, value: undefined };
      }
      try {
        const value = await validateValue<Row>(binding, result.value, fingerprint, rowIndex);
        rowIndex += 1;
        return { done: false, value };
      } catch (error) {
        await close().catch(() => undefined);
        throw error;
      }
    },
    async return(value?: unknown) {
      await close();
      return { done: true, value: value as Row };
    },
    async throw(error?: unknown) {
      await close();
      throw error;
    },
    close,
    [Symbol.asyncDispose]: close,
  };
  return validated;
}
