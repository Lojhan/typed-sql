import type { Database } from "@typed-sql/core";
import { typePolicy } from "@typed-sql/postgres";
import { createPostgresRoutedDatabase, postgres } from "@typed-sql/postgres/analysis";

export function createAccountRouter(primary: Database, replicas: readonly Database[], snapshot: unknown) {
  return createPostgresRoutedDatabase({
    primary,
    replicas,
    schema: postgres({ typePolicy }).validateSnapshot(snapshot),
    typePolicy,
  });
}
