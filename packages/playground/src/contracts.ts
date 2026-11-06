import type { Database, SchemaSnapshot } from "@typed-sql/core";

export interface PlaygroundIdentity {
  readonly database: string;
  readonly server: string;
  readonly adapter: string;
  readonly readOnly: boolean;
}

export interface PlaygroundQueryRequest {
  readonly text: string;
  readonly values: readonly unknown[];
  readonly readOnly: boolean;
  readonly maxRows: number;
  readonly pageSize?: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly maxResultBytes?: number;
  /** Incremental native-cursor delivery. Awaiting this callback applies database backpressure. */
  readonly cursorIdleMs?: number;
  readonly onRows?: (batch: PlaygroundQueryResult) => Promise<void>;
}

export interface PlaygroundColumn {
  readonly name: string;
  readonly databaseType?: string;
}

export interface PlaygroundQueryResult {
  readonly columns: readonly PlaygroundColumn[];
  readonly rows: readonly (readonly unknown[])[];
  readonly truncated: boolean;
  readonly command?: string;
  readonly affectedRows?: number;
}

/** An explicit, lazy, server-side service. Main package imports no driver. */
export interface PlaygroundTarget {
  /** Native incremental delivery with callback backpressure, rather than eager collection. */
  readonly rowStreaming?: boolean;
  identity(): Promise<PlaygroundIdentity>;
  query(request: PlaygroundQueryRequest): Promise<PlaygroundQueryResult>;
  /** Application-shaped execution; only managed calls inherit run cancellation/limits. */
  database(options: {
    readonly readOnly: boolean;
    readonly maxRows: number;
    readonly pageSize?: number;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
    readonly maxResultBytes?: number;
  }): Promise<Database>;
  snapshot?(): Promise<SchemaSnapshot>;
  close(): Promise<void>;
}

export interface PlaygroundLimits {
  readonly timeoutMs: number;
  readonly maxRows?: number;
  readonly pageSize?: number;
  readonly maxSpoolBytes?: number;
  readonly cursorIdleMs?: number;
  readonly maxResultBytes: number;
  readonly maxConsoleBytes: number;
}

export interface PlaygroundTargetConfig {
  readonly classification: "development" | "test" | "production";
  readonly expected?: { readonly database: string };
  readonly connect: () => PlaygroundTarget | Promise<PlaygroundTarget>;
}

export interface PlaygroundOptions {
  readonly config?: string;
  readonly project?: string;
  readonly target?: string;
  readonly port?: number;
}
