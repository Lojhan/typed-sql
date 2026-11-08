/** Shared across native verification, plan inspection and query-contract acquisition. */
export const activeSqlServerServices = new WeakSet<object>();
export const poisonedSqlServerServices = new WeakSet<object>();
