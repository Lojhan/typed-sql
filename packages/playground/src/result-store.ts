import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceError } from "./files.js";
import { encodeValue, type WireValue } from "./values.js";

export interface ResultPaging {
  readonly id: string;
  readonly rowCount: number;
  readonly pageCount: number;
  readonly pageSize: number;
  readonly complete: boolean;
  readonly source: "database-cursor" | "database-spool" | "materialized";
}

/** Private immutable pages are retained with the run. Quota failures are explicit, never truncation. */
export class ResultSpool {
  readonly id = randomUUID();
  rowCount = 0;
  pageCount = 0;
  first: WireValue | undefined;
  constructor(
    readonly directory: string,
    readonly pageSize: number,
    readonly maximumPageBytes: number,
    readonly source: ResultPaging["source"],
    readonly maximumBytes = 512 * 1024 * 1024,
    readonly budget = { bytes: 0 },
  ) {
    mkdirSync(join(directory, this.id), { recursive: true, mode: 0o700 });
  }
  append(value: unknown, rows: number): WireValue {
    const encoded = encodeValue(value, { maxBytes: this.maximumPageBytes });
    const text = JSON.stringify(encoded);
    this.budget.bytes += Buffer.byteLength(text);
    if (this.budget.bytes > this.maximumBytes)
      throw new WorkspaceError(
        "RESULT_LIMIT",
        "Captured run exceeds the configured disk quota; narrow the query. Captured pages remain incomplete.",
      );
    writeFileSync(join(this.directory, this.id, `${this.pageCount}.json`), text, { mode: 0o600, flag: "wx" });
    this.first ??= encoded;
    this.rowCount += rows;
    this.pageCount++;
    return encoded;
  }
  finalizeFirst(value: unknown): void {
    const encoded = encodeValue(value, { maxBytes: this.maximumPageBytes });
    const file = join(this.directory, this.id, "0.json");
    writeFileSync(file, JSON.stringify(encoded), { mode: 0o600 });
    this.first = encoded;
  }
  metadata(complete: boolean): ResultPaging {
    return {
      id: this.id,
      rowCount: this.rowCount,
      pageCount: this.pageCount,
      pageSize: this.pageSize,
      complete,
      source: this.source,
    };
  }
}
