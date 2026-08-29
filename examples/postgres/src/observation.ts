import type { DatabaseObserver, DatabaseOperationEnd, DatabaseOperationStart } from "@typed-sql/core";

export interface OperationLog {
  readonly starts: readonly DatabaseOperationStart[];
  readonly ends: readonly DatabaseOperationEnd[];
  readonly observer: DatabaseObserver;
}

export function createOperationLog(): OperationLog {
  const starts: DatabaseOperationStart[] = [];
  const ends: DatabaseOperationEnd[] = [];
  return {
    starts,
    ends,
    observer: {
      start(operation) {
        starts.push(operation);
        return { end: (completion) => ends.push(completion) };
      },
    },
  };
}
