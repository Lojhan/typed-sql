import { sqlServerContractPolicy } from "./contract-profile.js";
import {
  createSqlServerNativeContractAdapter,
  type SqlServerNativeContractAdapter,
  type SqlServerNativeContractOptions,
} from "./native-contracts.js";
import { createSqlServerOdbcDatabase, type SqlServerOdbcOptions } from "./odbc.js";

export interface SqlServerOdbcContractOptions
  extends Omit<SqlServerNativeContractOptions, "pool">,
    Omit<SqlServerOdbcOptions, "typePolicy"> {}

/** Each lease owns a fresh ODBC database. Constructing the adapter loads no native driver. */
export function createSqlServerOdbcNativeContractAdapter(
  options: SqlServerOdbcContractOptions,
): SqlServerNativeContractAdapter {
  const { schema, typePolicy, statementTimeoutMs, leaseTimeoutMs, ...connection } = options;
  const policy = sqlServerContractPolicy(typePolicy);
  return createSqlServerNativeContractAdapter({
    schema,
    typePolicy: policy,
    ...(statementTimeoutMs === undefined ? {} : { statementTimeoutMs }),
    ...(leaseTimeoutMs === undefined ? {} : { leaseTimeoutMs }),
    pool: {
      async acquire() {
        const database = await createSqlServerOdbcDatabase({ ...connection, typePolicy: policy });
        return {
          all: (sql, values) => database.queryable.all(sql, values),
          release: () => database.close(),
          discard: () => database.close(),
        };
      },
    },
  });
}
