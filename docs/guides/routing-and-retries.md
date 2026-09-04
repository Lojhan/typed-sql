---
title: Route reads and retry transactions
pageType: how-to
description: Route proven-safe reads to application-owned replicas and retry explicit transactions conservatively.
---

# Route reads and retry transactions

typed-sql can use the same grammar semantics that power compilation to choose between an application-owned primary database and application-owned replicas. It does not infer safety from a `SELECT` prefix, create pools, monitor replicas, or promise replication consistency.

Routing is opt-in. Existing adapters keep their thin direct execution path when it is disabled.

## Create a routed database

Create every driver adapter normally, then compose them with the dialect root. The schema snapshot lets the runtime resolver apply the same grammar and type policy as the compiler.

```ts
import snapshotJson from "./schema/catalog.snapshot.json" with { type: "json" };
import {
  createPostgresRoutedDatabase,
  postgres,
  sql,
  typePolicy,
} from "@typed-sql/postgres";
import { createPgDatabase } from "@typed-sql/postgres/pg";

const schema = postgres().validateSnapshot(snapshotJson);
const primary = await createPgDatabase({
  connectionString: process.env.PRIMARY_DATABASE_URL!,
  typePolicy,
});
const replica = await createPgDatabase({
  connectionString: process.env.REPLICA_DATABASE_URL!,
  typePolicy,
});

const database = createPostgresRoutedDatabase({
  primary,
  replicas: [replica],
  schema,
});
```

Use `createMySqlRoutedDatabase` with databases returned by `createMySql2Database` for MySQL. The routed database does not own its inputs, so close the primary and replicas through the original adapter references during application shutdown.

## Use one context per consistency scope

Call `context()` for each request, job, or other unit that needs read-after-write affinity:

```ts
const requestDatabase = database.context();

const before = await requestDatabase.all(sql`
  SELECT account.id, account.email
  FROM accounts AS account
  ORDER BY account.id
`); // eligible for a replica

await requestDatabase.execute(sql`
  UPDATE accounts
  SET last_seen_at = CURRENT_TIMESTAMP
  WHERE id = ${42n}
`); // primary; this context is now pinned

const after = await requestDatabase.all(sql`
  SELECT account.id, account.last_seen_at
  FROM accounts AS account
  WHERE account.id = ${42n}
`); // primary because the context is pinned
```

A pin lasts for the lifetime of that context. A different context remains independent. This is a conservative read-after-write mechanism, not a claim about replica lag, causal consistency across processes, or failover.

## Understand the routing decision

A query is eligible for a replica only when grammar-produced semantics prove all of these facts:

- the operation is a read;
- volatility is `immutable` or `stable`;
- no row-locking clause is present; and
- no connection or transaction affinity is required.

Writes, DDL, data-changing or ambiguous CTEs, locking reads, volatile functions, session state, transaction control, unsupported SQL, and failed analysis all choose primary. Unknown never means safe.

Automatic routing falls back to primary when no replica is configured. Replicas use round-robin selection by default. Applications can inject `selectReplica` to integrate their own topology or health state:

```ts
const database = createPostgresRoutedDatabase({
  primary,
  replicas,
  schema,
  selectReplica({ replicaCount, roundRobinIndex, semantics }) {
    return chooseHealthyReplica({ replicaCount, roundRobinIndex, semantics });
  },
});
```

The selector returns a zero-based index into the supplied replica list. An invalid index fails before driver dispatch. typed-sql does not remove unhealthy replicas, measure lag, discover services, or promote a primary.

## Require a role explicitly

Use a view when application policy is stricter than automatic routing:

```ts
await database.context().withRoute("primary").all(accountQuery);
await database.context().withRoute("replica").all(reportQuery);
```

Forcing primary is always safe and pins that context. Forcing replica still requires semantic proof. An unsafe query, a primary-pinned context, or a missing replica throws `UnsafeReplicaRoutingError` with code `TSQL_UNSAFE_REPLICA_ROUTE` before execution. `pinPrimary()` is available when non-query application state requires affinity.

Pass a routing observer when role decisions need metrics or diagnostics:

```ts
const database = createPostgresRoutedDatabase({
  primary,
  replicas,
  schema,
  observer: {
    route(selection) {
      recordRoute(selection.route, selection.semantics.operation.value);
    },
  },
});
```

Observer failures are isolated from execution. The event contains semantic evidence and the selected role, not SQL text, parameter values, or connection configuration.

## Retry an explicit transaction

Retries are never automatic. Supply a bounded policy to an explicit routed transaction and use the dialect classifier:

```ts
import { isPostgresRetryableTransactionError } from "@typed-sql/postgres";

const controller = new AbortController();

const account = await database.context().transaction(
  async (transaction) => {
    await transaction.execute(debitAccount);
    await transaction.execute(creditAccount);
    return transaction.one(updatedAccount);
  },
  {
    retry: {
      maximumAttempts: 3,
      classify: isPostgresRetryableTransactionError,
      backoff: ({ attempt }) => 25 * 2 ** (attempt - 1),
      signal: controller.signal,
      onRetry: ({ attempt, delayMilliseconds }) => {
        recordTransactionRetry(attempt, delayMilliseconds);
      },
    },
  },
);
```

PostgreSQL retries only SQLSTATE `40001` (`serialization_failure`) and `40P01` (`deadlock_detected`). MySQL retries InnoDB deadlock identity (`ER_LOCK_DEADLOCK`, error number `1213`, or SQLSTATE `40001`) and deliberately excludes lock-wait timeout `1205`. Classifiers inspect native fields rather than message text.

Every attempt starts a new primary transaction. Retry is possible only for a classified database failure before the callback starts, during an awaited database operation, or while committing. A thrown application callback error is not retried even when it happens to resemble a driver error. Non-transient errors and exhausted policies are returned unchanged.

The callback can execute more than once. Keep irreversible external effects—sending email, publishing messages, charging a card—outside it unless they have their own idempotency protocol. The retry observer should also be best-effort; its failures do not replace the transaction result.

The default wait is abortable. Tests and applications with a scheduler can inject `sleep(delayMilliseconds, signal)` for deterministic time.

## Keep adapter-only operations explicit

`RoutedDatabase` intentionally implements the minimal buffered `Database` contract: `execute`, `all`, `one`, `maybeOne`, and explicit transactions. It does not silently invent routing semantics for a multi-query batch, a PostgreSQL pipeline, a long-lived stream, or a prepared-statement registry.

Use the original adapter directly when calling `batch`, `pipeline`, `stream`, or `prepare`, and choose its role explicitly according to the operation's consistency requirements. Transaction retries do not apply to arbitrary statements or streams.

## Consistency and ownership limits

- A replica can return stale data even when a query is semantically safe.
- Context pinning affects only that in-process routed context.
- Driver pools, credentials, TLS, health checks, lag thresholds, load balancing, failover, and shutdown remain application-owned.
- The routed adapter intersects execution capabilities across all configured databases; a control is advertised only when every possible target supports it.
- Routing analysis is cached by immutable query identity and structural SQL shape. Parameter values are excluded from the shape.

These boundaries keep the feature useful without turning typed-sql into a proxy, topology manager, or ORM.
