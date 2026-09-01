import {
  type ParseOptions,
  parseStatement as parseCompatibilityStatement,
  type SqlAstVisitor,
  SqlParseError,
  type Statement,
  type Token,
} from "../../packages/ast/src/index.js";

interface ParserStatementEvidence {
  readonly kind: string;
  readonly range: unknown;
}

interface CorpusVisitor {
  readonly statement: () => void;
  readonly expression: () => void;
}

export interface OwnedParserCorpusApi<
  StatementType extends ParserStatementEvidence = Statement,
  VisitorType = SqlAstVisitor,
> {
  readonly dialect: "postgres" | "mysql" | "sqlite";
  readonly parseStatement: (
    source: string,
    options?: { readonly maxDepth?: number; readonly maxTokens?: number; readonly maxSqlLength?: number },
  ) => StatementType;
  readonly tokenize: (
    source: string,
    options?: { readonly maxTokens?: number; readonly maxSqlLength?: number },
  ) => readonly Token[];
  readonly walkStatement: (statement: StatementType, visitor: VisitorType) => void;
  readonly isParseError: (error: unknown) => boolean;
  readonly compareWithCompatibilityParser?: boolean;
}

const commonValid = [
  "SELECT ALL 1 AS one WHERE false ORDER BY one ASC",
  `SELECT CASE age WHEN 1 THEN true ELSE false END flag,
          CASE WHEN age IS NOT NULL THEN +age END AS maybe_age,
          COALESCE(name, 'anonymous') display_name, COUNT(DISTINCT id) total,
          u.*, NULL AS missing, -age + 2 * 3 AS score
   FROM users u FULL JOIN ages a ON true`,
  `WITH recent(id, name) AS (
     SELECT u.id, u.name FROM users u WHERE u.id IN (SELECT a.user_id FROM ages a)
   )
   SELECT derived.*, r.name
   FROM (SELECT id FROM users WHERE EXISTS (SELECT 1 FROM ages WHERE ages.user_id = users.id)) AS derived
   JOIN recent r USING (id)`,
  `SELECT id NOT IN (1, 2), id IN (SELECT id FROM users), id BETWEEN 1 AND 2,
          name NOT LIKE 'x%', id IS NULL, id IS NOT NULL,
          EXISTS (SELECT 1), (SELECT 1), (1, 'two'), ROW(), ROW(1, 2),
          public.calculate(), NOT active, +id, -id, ~id, false, DEFAULT
   FROM users`,
  "SELECT id FROM users INNER JOIN ages a ON users.id = a.user_id RIGHT OUTER JOIN scores s USING (id)",
  "SELECT COUNT(*) OVER (PARTITION BY active ORDER BY id DESC) AS ranked FROM users WINDOW activity AS (ORDER BY id)",
  "INSERT INTO users AS u (name, age) VALUES ('Ada', 37), ('Grace', NULL) RETURNING u.*",
  "INSERT INTO users (name) SELECT name FROM archived_users RETURNING id",
  "INSERT INTO users DEFAULT VALUES",
  "UPDATE users u SET name = 'Ada', age = age + 1 FROM ages a WHERE a.user_id = u.id RETURNING u.id",
  "DELETE FROM users u USING ages a, audit WHERE a.user_id = u.id RETURNING u.*",
  "WITH RECURSIVE tree(id) AS (SELECT 1) SELECT id FROM tree",
] as const;

const dialectValid: Readonly<Record<OwnedParserCorpusApi["dialect"], readonly string[]>> = {
  postgres: [
    "SELECT DISTINCT ON (team_id, created_at) id FROM users ORDER BY team_id, created_at",
    "SELECT ARRAY[1, 2], payload->>'name', value::numeric(14, 2)[] FROM events WHERE payload @> '{}'::jsonb",
    "SELECT COUNT(*) FILTER (WHERE active) OVER activity FROM users",
    "SELECT id FROM users FOR NO KEY UPDATE OF users NOWAIT FOR KEY SHARE SKIP LOCKED",
    "SELECT E'line\\nnext', $body$dollar text$body$, $2",
    "SELECT CAST(value AS timestamp without time zone), CAST(value AS double precision) FROM values_table",
  ],
  mysql: [
    'SELECT `user`.`id`, "text" AS label FROM `users` AS `user` WHERE `user`.`id` = ? LIMIT 5, 10',
    '/* outer /* inner */ done */ SELECT "a""b", `a``b` FROM `users` ORDER BY id NULLS FIRST, id NULLS LAST',
    "SELECT id FROM users LOCK IN SHARE MODE",
    "SELECT u.id FROM users u JOIN projects p ON p.owner_id = u.id FOR SHARE OF u FOR UPDATE OF p",
    "SELECT JSON_EXTRACT(profile, '$.plan'), id IN (?, ?) FROM users",
    "SELECT id IS DISTINCT FROM owner_id, id IS NOT DISTINCT FROM owner_id FROM users",
    "SELECT CAST(id AS timestamp without time zone), CAST(id AS numeric(10, 2)[]), CAST(id AS public.money) FROM users",
  ],
  sqlite: [
    "SELECT [account].[id], `account`.`email` FROM [account] WHERE [id] = ?",
    "SELECT 1 AS value UNION ALL SELECT 2 EXCEPT SELECT 3 ORDER BY value LIMIT 1",
    "SELECT COUNT(*) FILTER (WHERE active) OVER (PARTITION BY team_id ORDER BY created_at) FROM events",
    "SELECT id FROM users LIMIT 5, 10",
  ],
};

const invalid = [
  "",
  "MERGE INTO users",
  "SELECT",
  "SELECT CASE END",
  "SELECT CAST(1 AS)",
  "SELECT (1",
  "SELECT 1 trailing garbage",
  "SELECT * FROM (UPDATE users SET name = 'x') u",
  "SELECT EXISTS (DELETE FROM users)",
  "SELECT (UPDATE users SET name = 'x')",
  "SELECT id IN (UPDATE users SET name = 'x')",
  "INSERT INTO users",
  "SELECT * FROM users JOIN accounts",
  "SELECT * FROM (users) u",
  "SELECT id IN ()",
  "SELECT CAST(value AS numeric(10, 2)",
  "SELECT CAST(value AS text extra)",
  "SELECT 'unterminated",
  "SELECT /* unterminated",
] as const;

function compatibilityOptions(dialect: OwnedParserCorpusApi["dialect"]): ParseOptions {
  return dialect === "postgres" ? {} : { syntax: dialect };
}

function outcome<StatementType extends ParserStatementEvidence>(
  parse: (source: string) => StatementType,
  source: string,
  isParseError: (error: unknown) => boolean,
): unknown {
  try {
    const statement = parse(source);
    return { kind: statement.kind, range: statement.range };
  } catch (error) {
    if (!isParseError(error)) throw error;
    const diagnostic = error as SqlParseError;
    return { code: diagnostic.code, message: diagnostic.message, range: diagnostic.range };
  }
}

function randomSources(seed: number, count: number): readonly string[] {
  let state = seed >>> 0;
  const alphabet = "SELECT FROM WHERE WITH INSERT UPDATE DELETE RETURNING abc_123$?(),.*+-/'\\\"[]`\n\t";
  const sources: string[] = [];
  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const length = state % 120;
    let source = "";
    for (let offset = 0; offset < length; offset += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      source += alphabet[state % alphabet.length];
    }
    sources.push(source);
  }
  return sources;
}

export function assertOwnedParserCorpus<StatementType extends ParserStatementEvidence, VisitorType>(
  api: OwnedParserCorpusApi<StatementType, VisitorType>,
): void {
  const options = compatibilityOptions(api.dialect);
  let visitedExpressions = 0;
  for (const source of [...commonValid, ...dialectValid[api.dialect]]) {
    const actual = api.parseStatement(source);
    if (api.compareWithCompatibilityParser !== false) {
      const expected = parseCompatibilityStatement(source, options);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${api.dialect} parser diverged for ${JSON.stringify(source)}`);
      }
    }
    if (!Object.isFrozen(actual) || !Object.isFrozen(actual.range)) {
      throw new Error(`${api.dialect} parser returned mutable AST evidence`);
    }
    let statements = 0;
    const visitor: CorpusVisitor = {
      statement: () => {
        statements += 1;
      },
      expression: () => {
        visitedExpressions += 1;
      },
    };
    api.walkStatement(actual, visitor as VisitorType);
    if (statements < 1) throw new Error(`${api.dialect} walker omitted statement nodes`);
  }
  if (visitedExpressions < 1) throw new Error(`${api.dialect} walker omitted expression nodes`);

  for (const source of invalid) {
    const actual = outcome(api.parseStatement, source, api.isParseError);
    if (api.compareWithCompatibilityParser !== false) {
      const expected = outcome(
        (text) => parseCompatibilityStatement(text, options),
        source,
        (error) => error instanceof SqlParseError,
      );
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${api.dialect} diagnostic diverged for ${JSON.stringify(source)}`);
      }
    }
  }

  for (const source of randomSources(0x51_7a_2026, 500)) {
    const first = outcome(api.parseStatement, source, api.isParseError);
    const second = outcome(api.parseStatement, source, api.isParseError);
    if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error(`${api.dialect} parser is nondeterministic`);
  }

  for (const operation of [
    () => api.tokenize("SELECT 1", { maxSqlLength: 0 }),
    () => api.tokenize("SELECT 1", { maxTokens: Number.NaN }),
    () => api.parseStatement("SELECT 1", { maxDepth: 0 }),
    () => api.tokenize("SELECT 1e+"),
    () => api.tokenize("SELECT /* unterminated"),
  ]) {
    let failed = false;
    try {
      operation();
    } catch {
      failed = true;
    }
    if (!failed) throw new Error(`${api.dialect} parser accepted invalid limits or lexical input`);
  }
  try {
    api.parseStatement(`SELECT ${"(".repeat(20)}1${")".repeat(20)}`, { maxDepth: 8 });
    throw new Error(`${api.dialect} parser did not enforce its depth limit`);
  } catch (error) {
    if (!api.isParseError(error)) throw error;
  }
}
