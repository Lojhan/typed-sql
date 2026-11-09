import type { Database } from "@typed-sql/core";
import { typePolicy } from "@typed-sql/mysql";
import { createMySqlRoutedDatabase, mysql } from "@typed-sql/mysql/analysis";

export function createAccountRouter(primary: Database, replicas: readonly Database[], snapshot: unknown) {
  return createMySqlRoutedDatabase({
    primary,
    replicas,
    schema: mysql({ typePolicy }).validateSnapshot(snapshot),
    typePolicy,
  });
}
