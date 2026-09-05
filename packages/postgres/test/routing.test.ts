import { sql } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { recordingDatabase } from "../../../test/helpers/recording-database.js";
import {
  createPostgresQuerySemanticResolver,
  createPostgresRoutedDatabase,
  isPostgresRetryableTransactionError,
  typePolicy,
} from "../src/index.js";

const schema = {
  formatVersion: 1,
  dialect: "postgres",
  tables: {
    "public.account": {
      schema: "public",
      name: "account",
      columns: {
        id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
        active: { name: "active", databaseType: "boolean", tsType: "boolean", nullable: false },
      },
    },
  },
} as const;

function database(name: string, calls: string[]) {
  return recordingDatabase(name, calls, {
    placeholder: (index) => `$${index}`,
    quoteIdentifier: (value) => `"${value}"`,
  });
}

await describe("PostgreSQL semantic routing adapter", async () => {
  await it("uses cached grammar semantics for reads, CTE writes, locking reads, volatility, and unknown SQL", async () => {
    const calls: string[] = [];
    const read = sql`SELECT account.id FROM account WHERE account.id = ${1n}`;
    const writeCte = sql`WITH changed AS (UPDATE account SET active = TRUE RETURNING id) SELECT id FROM changed`;
    const locking = sql`SELECT account.id FROM account FOR UPDATE`;
    const volatile = sql`SELECT RANDOM() AS value`;
    const invalid = sql`SELECT missing FROM account`;
    const uncertain = [
      sql.dynamic("SET search_path = public"),
      sql.dynamic("BEGIN"),
      sql.dynamic("CREATE TEMP TABLE session_cache (id bigint)"),
    ];
    const resolver = createPostgresQuerySemanticResolver({ schema });
    strict.strictEqual(resolver.resolve(read), resolver.resolve(read));
    strict.strictEqual(
      resolver.resolve(read),
      resolver.resolve(sql`SELECT account.id FROM account WHERE account.id = ${2n}`),
    );
    strict.strictEqual(resolver.resolve(read).operation.value, "read");
    strict.strictEqual(resolver.resolve(writeCte).operation.value, "write");
    strict.strictEqual(resolver.resolve(locking).locking.value, "row");
    strict.strictEqual(resolver.resolve(volatile).volatility.value, "volatile");
    strict.strictEqual(resolver.resolve(invalid).operation.value, "unknown");
    for (const query of uncertain) strict.strictEqual(resolver.resolve(query).operation.value, "unknown");
    strict.strictEqual(
      createPostgresQuerySemanticResolver({ schema, typePolicy }).resolve(sql`SELECT ${sql.ident("id")} FROM account`)
        .operation.value,
      "read",
    );
    strict.throws(() => createPostgresQuerySemanticResolver({ schema: null as never }).resolve(sql`SELECT 1`));

    let selections = 0;
    const routed = createPostgresRoutedDatabase({
      primary: database("primary", calls),
      replicas: [database("replica", calls)],
      schema,
      selectReplica: () => 0,
      observer: {
        route: () => {
          selections += 1;
        },
      },
    });
    await routed.execute(read);
    await routed.execute(writeCte);
    await routed.execute(locking);
    await routed.execute(volatile);
    for (const query of uncertain) await routed.execute(query);
    strict.deepStrictEqual(calls, ["replica", "primary", "primary", "primary", "primary", "primary", "primary"]);
    strict.strictEqual(selections, 7);

    await createPostgresRoutedDatabase({ primary: database("primary", calls), schema }).execute(read);
    strict.strictEqual(calls.at(-1), "primary");
  });

  await it("classifies only documented PostgreSQL transaction rollback codes", () => {
    strict.strictEqual(isPostgresRetryableTransactionError({ code: "40001" }), true);
    strict.strictEqual(isPostgresRetryableTransactionError({ code: "40P01" }), true);
    strict.strictEqual(isPostgresRetryableTransactionError({ code: "23505" }), false);
    strict.strictEqual(isPostgresRetryableTransactionError(new Error("40001")), false);
    strict.strictEqual(isPostgresRetryableTransactionError(null), false);
  });
});
