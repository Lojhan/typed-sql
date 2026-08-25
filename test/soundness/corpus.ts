export type SoundnessDialect = "postgres" | "mysql";

export type SoundnessExpectation =
  | {
      readonly kind: "exact";
      readonly rowType: string;
      readonly parameterType: string;
      readonly resultKind?: "rows" | "command";
    }
  | {
      readonly kind: "unknown";
      readonly target: "row" | "parameters";
      readonly diagnosticCodes?: readonly string[];
    }
  | {
      readonly kind: "diagnostic";
      readonly codes: readonly string[];
    };

export interface DialectSoundnessCase {
  readonly sql: (placeholder: (index: number) => string) => string;
  readonly parameterCount?: number;
  readonly expectation: SoundnessExpectation;
}

export interface SoundnessCase {
  readonly id: string;
  readonly family: string;
  readonly postgres: DialectSoundnessCase;
  readonly mysql: DialectSoundnessCase;
}

const exact = (
  rowType: string,
  parameterType = "readonly []",
  resultKind: "rows" | "command" = "rows",
): SoundnessExpectation => ({ kind: "exact", rowType, parameterType, resultKind });

const diagnostic = (...codes: readonly string[]): SoundnessExpectation => ({ kind: "diagnostic", codes });

const unknown = (target: "row" | "parameters", diagnosticCodes: readonly string[] = []): SoundnessExpectation => ({
  kind: "unknown",
  target,
  diagnosticCodes,
});

export const soundnessCorpus: readonly SoundnessCase[] = [
  {
    id: "select-columns",
    family: "select",
    postgres: {
      sql: () => "SELECT users.id, users.email FROM users",
      expectation: exact('{ "id": bigint; "email": string; }'),
    },
    mysql: {
      sql: () => "SELECT users.id, users.email FROM users",
      expectation: exact('{ "id": bigint; "email": string; }'),
    },
  },
  {
    id: "left-join-nullability",
    family: "join",
    postgres: {
      sql: () => "SELECT users.id, projects.budget FROM users LEFT JOIN projects ON users.id = projects.owner_id",
      expectation: exact('{ "id": bigint; "budget": string | null; }'),
    },
    mysql: {
      sql: () => "SELECT users.id, projects.budget FROM users LEFT JOIN projects ON users.id = projects.owner_id",
      expectation: exact('{ "id": bigint; "budget": string | null; }'),
    },
  },
  {
    id: "alias-and-enum",
    family: "alias",
    postgres: {
      sql: () => "SELECT account.id AS account_id, account.status FROM users AS account",
      expectation: exact('{ "account_id": bigint; "status": "active" | "suspended"; }'),
    },
    mysql: {
      sql: () => "SELECT account.id AS account_id, account.status FROM users AS account",
      expectation: exact('{ "account_id": bigint; "status": "active" | "suspended"; }'),
    },
  },
  {
    id: "common-table-expression",
    family: "cte",
    postgres: {
      sql: () =>
        "WITH selected AS (SELECT users.id, users.email FROM users) SELECT selected.id, selected.email FROM selected",
      expectation: exact('{ "id": bigint; "email": string; }'),
    },
    mysql: {
      sql: () =>
        "WITH selected AS (SELECT users.id, users.email FROM users) SELECT selected.id, selected.email FROM selected",
      expectation: exact('{ "id": bigint; "email": string; }'),
    },
  },
  {
    id: "correlated-subquery",
    family: "subquery",
    postgres: {
      sql: () =>
        "SELECT users.id, (SELECT projects.budget FROM projects WHERE projects.owner_id = users.id) AS budget FROM users",
      expectation: exact('{ "id": bigint; "budget": string | null; }'),
    },
    mysql: {
      sql: () =>
        "SELECT users.id, (SELECT projects.budget FROM projects WHERE projects.owner_id = users.id) AS budget FROM users",
      expectation: exact('{ "id": bigint; "budget": string | null; }'),
    },
  },
  {
    id: "aggregate-window",
    family: "aggregate-window",
    postgres: {
      sql: () => "SELECT COUNT(*) OVER (PARTITION BY users.status) AS total FROM users",
      expectation: exact('{ "total": bigint; }'),
    },
    mysql: {
      sql: () => "SELECT COUNT(*) OVER (PARTITION BY users.status) AS total FROM users",
      expectation: exact('{ "total": bigint; }'),
    },
  },
  {
    id: "catalog-function",
    family: "function",
    postgres: {
      sql: () => "SELECT active_user_count() AS total",
      expectation: exact('{ "total": bigint | null; }'),
    },
    mysql: {
      sql: () => "SELECT user_count() AS total",
      expectation: exact('{ "total": bigint | null; }'),
    },
  },
  {
    id: "dialect-cast",
    family: "cast",
    postgres: {
      sql: () => "SELECT users.id::text AS id_text FROM users",
      expectation: exact('{ "id_text": string; }'),
    },
    mysql: {
      sql: () => "SELECT CAST(users.id AS CHAR) AS id_text FROM users",
      expectation: exact('{ "id_text": string; }'),
    },
  },
  {
    id: "insert-returning",
    family: "dml",
    postgres: {
      sql: (placeholder) =>
        `INSERT INTO users (email, status) VALUES (${placeholder(1)}, ${placeholder(2)}) RETURNING id, status`,
      parameterCount: 2,
      expectation: exact(
        '{ "id": bigint; "status": "active" | "suspended"; }',
        'readonly [string, "active" | "suspended"]',
      ),
    },
    mysql: {
      sql: (placeholder) =>
        `INSERT INTO users (email, status) VALUES (${placeholder(1)}, ${placeholder(2)}) RETURNING id, status`,
      parameterCount: 2,
      expectation: diagnostic("TSQ401"),
    },
  },
  {
    id: "update-command",
    family: "dml",
    postgres: {
      sql: (placeholder) => `UPDATE users SET status = ${placeholder(1)} WHERE id = ${placeholder(2)}`,
      parameterCount: 2,
      expectation: exact("never", 'readonly ["active" | "suspended", bigint]', "command"),
    },
    mysql: {
      sql: (placeholder) => `UPDATE users SET status = ${placeholder(1)} WHERE id = ${placeholder(2)}`,
      parameterCount: 2,
      expectation: exact("never", 'readonly ["active" | "suspended", bigint]', "command"),
    },
  },
  {
    id: "ordered-parameters",
    family: "parameters",
    postgres: {
      sql: (placeholder) =>
        `SELECT users.id FROM users WHERE users.status = ${placeholder(1)} AND users.id >= ${placeholder(2)}`,
      parameterCount: 2,
      expectation: exact('{ "id": bigint; }', 'readonly ["active" | "suspended", bigint]'),
    },
    mysql: {
      sql: (placeholder) =>
        `SELECT users.id FROM users WHERE users.status = ${placeholder(1)} AND users.id >= ${placeholder(2)}`,
      parameterCount: 2,
      expectation: exact('{ "id": bigint; }', 'readonly ["active" | "suspended", bigint]'),
    },
  },
  {
    id: "unconstrained-parameter",
    family: "unknown",
    postgres: {
      sql: (placeholder) => `SELECT ${placeholder(1)} AS value`,
      parameterCount: 1,
      expectation: unknown("parameters"),
    },
    mysql: {
      sql: (placeholder) => `SELECT ${placeholder(1)} AS value`,
      parameterCount: 1,
      expectation: unknown("parameters"),
    },
  },
  {
    id: "unknown-function",
    family: "unknown",
    postgres: {
      sql: () => "SELECT unregistered_function(users.id) AS value FROM users",
      expectation: unknown("row", ["TSQ202"]),
    },
    mysql: {
      sql: () => "SELECT unregistered_function(users.id) AS value FROM users",
      expectation: unknown("row", ["TSQ202"]),
    },
  },
  {
    id: "missing-column-stale-schema",
    family: "diagnostic",
    postgres: {
      sql: () => "SELECT users.deleted_at FROM users",
      expectation: diagnostic("TSQ101"),
    },
    mysql: {
      sql: () => "SELECT users.deleted_at FROM users",
      expectation: diagnostic("TSQ103"),
    },
  },
  {
    id: "ambiguous-column",
    family: "diagnostic",
    postgres: {
      sql: () => "SELECT id FROM users JOIN projects ON users.id = projects.owner_id",
      expectation: diagnostic("TSQ102"),
    },
    mysql: {
      sql: () => "SELECT id FROM users JOIN projects ON users.id = projects.owner_id",
      expectation: diagnostic("TSQ102"),
    },
  },
  {
    id: "duplicate-output-name",
    family: "diagnostic",
    postgres: {
      sql: () => "SELECT users.id, projects.id FROM users JOIN projects ON users.id = projects.owner_id",
      expectation: diagnostic("TSQ105"),
    },
    mysql: {
      sql: () => "SELECT users.id, projects.id FROM users JOIN projects ON users.id = projects.owner_id",
      expectation: diagnostic("TSQ105"),
    },
  },
  {
    id: "dialect-specific-filter",
    family: "unsupported",
    postgres: {
      sql: () => "SELECT COUNT(*) FILTER (WHERE users.status = 'active') AS total FROM users",
      expectation: exact('{ "total": bigint; }'),
    },
    mysql: {
      sql: () => "SELECT COUNT(*) FILTER (WHERE users.status = 'active') AS total FROM users",
      expectation: diagnostic("TSQ001"),
    },
  },
  {
    id: "malformed-query",
    family: "diagnostic",
    postgres: { sql: () => "SELECT users.id FROM users WHERE", expectation: diagnostic("TSQ001") },
    mysql: { sql: () => "SELECT users.id FROM users WHERE", expectation: diagnostic("TSQ001") },
  },
] as const;
