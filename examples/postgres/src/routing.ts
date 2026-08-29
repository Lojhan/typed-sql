import type { Database } from "@typed-sql/core";
import { createPostgresRoutedDatabase, postgres, typePolicy } from "@typed-sql/postgres";

export function createAccountRouter(primary: Database, replicas: readonly Database[], snapshot: unknown) {
  return createPostgresRoutedDatabase({
    primary,
    replicas,
    schema: postgres({ typePolicy }).validateSnapshot(snapshot),
    typePolicy,
  });
}
