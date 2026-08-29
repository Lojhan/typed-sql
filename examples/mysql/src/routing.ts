import type { Database } from "@typed-sql/core";
import { createMySqlRoutedDatabase, mysql, typePolicy } from "@typed-sql/mysql";

export function createAccountRouter(primary: Database, replicas: readonly Database[], snapshot: unknown) {
  return createMySqlRoutedDatabase({
    primary,
    replicas,
    schema: mysql({ typePolicy }).validateSnapshot(snapshot),
    typePolicy,
  });
}
