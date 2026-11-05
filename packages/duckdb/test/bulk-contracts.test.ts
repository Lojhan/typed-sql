import { type Query, sql } from "@typed-sql/core";
import { it, strict } from "poku";
import { createDuckDBAppenderCapability } from "../src/bulk.js";
await it("enforces the typed appender statement contract and producer cleanup", async () => {
  let text = "INSERT INTO target(id) VALUES($1)",
    transfers = 0,
    closes = 0,
    consumed = true;
  const appender = createDuckDBAppenderCapability({
    prepare() {
      return { text, bindings: [{ type: { kind: "scalar", name: "INTEGER" }, value: 1 }] };
    },
    async transfer(_target, _row, chunks) {
      transfers++;
      if (consumed)
        for await (const _rows of chunks) {
        }
    },
  });
  const rowQuery = () => sql`SELECT 1` as Query<unknown, readonly []>;
  for (const invalid of [
    "SELECT $1",
    "WITH t AS(SELECT 1) INSERT INTO target(id) VALUES($1)",
    "INSERT INTO target(id) SELECT $1",
    "INSERT INTO target(id) VALUES($1) ON CONFLICT DO NOTHING",
    "INSERT INTO target(id) VALUES($1) RETURNING id",
    "INSERT INTO target BY NAME SELECT $1 AS id",
    "INSERT INTO target VALUES($1)",
    "INSERT INTO target(id) VALUES($1),($1)",
    "INSERT INTO target(id,other) VALUES($1,$2)",
    "INSERT INTO target(id) VALUES(1)",
    "INSERT INTO target(id) VALUES($2)",
    "INSERT INTO target(id,id) VALUES($1,$2)",
  ]) {
    text = invalid;
    async function* source() {
      try {
        yield 1;
      } finally {
        closes++;
      }
    }
    await strict.rejects(appender.append(rowQuery, source()), /requires/u);
  }
  strict.equal(transfers, 0);
  strict.equal(closes, 12);
  text = "INSERT INTO target(id) VALUES($1)";
  consumed = false;
  await strict.rejects(appender.append(rowQuery, [1]), /consume/u);
  consumed = true;
  await strict.rejects(
    appender.append(() => {
      throw new Error("factory failure");
    }, [1]),
    /factory failure/u,
  );
  await strict.rejects(
    appender.append(rowQuery, {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new Error("source failure");
          },
          async return() {
            throw new Error("cleanup failure");
          },
        };
      },
    }),
    /source failure/u,
  );
  const aborted = new AbortController();
  aborted.abort();
  await strict.rejects(appender.append(rowQuery, [], { signal: aborted.signal }), /cancel/u);
});
