import { createDatabase, type SqlRenderer } from "@typed-sql/core";

/** A fresh executor with a caller-owned event log; rendering policy stays in the test. */
export function recordingDatabase(name: string, calls: string[], renderer: SqlRenderer) {
  return createDatabase(
    {
      execute: async () => {
        calls.push(name);
        return [{ name }];
      },
    },
    renderer,
  );
}
