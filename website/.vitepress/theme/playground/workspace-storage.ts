import { DEFAULT_SCHEMAS, PLAYGROUND_DIALECTS, type PlaygroundDialect } from "./playground.js";
import {
  LESSONS,
  type Lesson,
  lessonFiles,
  lessonSupportsDialect,
  validWorkspaceFiles,
  type WorkspaceFiles,
} from "./workspace.js";

export const WORKSPACE_STORAGE_KEY = "typed-sql.playground.v2";
export const LEGACY_STORAGE_KEY = "typed-sql.playground.v1";
export type WorkspaceExample = Lesson | "custom";
export interface StoredWorkspace {
  files: WorkspaceFiles;
  example: WorkspaceExample;
}
export interface PlaygroundState {
  version: 2;
  dialect: PlaygroundDialect;
  workspaces: Record<PlaygroundDialect, StoredWorkspace>;
}

function sameSource(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left.trim() === right.trim();
}

function sameFiles(left: WorkspaceFiles, right: WorkspaceFiles): boolean {
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(([path, source]) => sameSource(source, right[path]))
  );
}

export function identifyExample(dialect: PlaygroundDialect, files: WorkspaceFiles): WorkspaceExample {
  return (
    LESSONS.find(
      ({ id }) =>
        lessonSupportsDialect(id, dialect) && sameFiles(files, lessonFiles(dialect, id, DEFAULT_SCHEMAS[dialect])),
    )?.id ?? "custom"
  );
}

export function defaultPlaygroundState(): PlaygroundState {
  return {
    version: 2,
    dialect: "postgres",
    workspaces: Object.fromEntries(
      PLAYGROUND_DIALECTS.map((dialect): [PlaygroundDialect, StoredWorkspace] => [
        dialect,
        { files: lessonFiles(dialect, "workspace", DEFAULT_SCHEMAS[dialect]), example: "workspace" },
      ]),
    ) as PlaygroundState["workspaces"],
  };
}

// Only exact, shipped starter projects are replaceable. Custom projects remain untouched.
export function upgradeLegacyWorkspace(dialect: PlaygroundDialect, files: WorkspaceFiles): StoredWorkspace {
  const current = lessonFiles(dialect, "workspace", DEFAULT_SCHEMAS[dialect]);
  const extras = Object.fromEntries(
    Object.entries(current).filter(([path]) => path.startsWith("queries/") || path === "schema/functions.sql"),
  );
  const candidates: WorkspaceFiles[] = [];
  for (const { id } of LESSONS) {
    if (id === "workspace" || id === "commerce") continue;
    const modern = lessonFiles(dialect, id, DEFAULT_SCHEMAS[dialect]);
    // The old dynamic example used the same account table name for every dialect.
    const query =
      id === "unknown"
        ? modern["queries/account.ts"].replace(
            /sql\.dynamic\("SELECT \* FROM [^"]+"\)/u,
            'sql.dynamic("SELECT * FROM account")',
          )
        : modern["queries/account.ts"];
    const basic: WorkspaceFiles = {
      "app.ts": modern["app.ts"].replace("./queries/account.ts", "./queries"),
      "queries.ts": query,
      "schema.sql": modern["schema/tables.sql"],
    };
    candidates.push(basic, { ...basic, ...extras });
  }
  const basicApp = lessonFiles(dialect, "basics", DEFAULT_SCHEMAS[dialect])["app.ts"];
  const oldWorkspaceApp =
    basicApp
      .replace(
        'import { accountById } from "./queries/account.ts";',
        'import accountById from "./queries/account.sql";\nimport { accountById as accountFromTemplate } from "./queries/account";\nimport { accountSummary } from "./queries/summary";',
      )
      .trimEnd() +
    "\n\nconst templateQuery = accountFromTemplate(42n);\nconst summaryRows = await database.all(accountSummary);\n";
  candidates.push({
    ...extras,
    "app.ts": oldWorkspaceApp,
    "queries.ts": 'export { accountById } from "./queries/account";\n',
    "schema.sql": DEFAULT_SCHEMAS[dialect],
  });
  const matching = candidates.find((candidate) => sameFiles(files, candidate));
  if (!matching) return { files: { ...files }, example: identifyExample(dialect, files) };
  const upgraded = { ...current };
  return validWorkspaceFiles(upgraded)
    ? { files: upgraded, example: identifyExample(dialect, upgraded) }
    : { files: { ...files }, example: "custom" };
}

export function restorePlaygroundState(saved: unknown, legacy?: unknown): PlaygroundState {
  const state = defaultPlaygroundState();
  if (
    typeof saved === "object" &&
    saved !== null &&
    "version" in saved &&
    saved.version === 2 &&
    "workspaces" in saved &&
    typeof saved.workspaces === "object" &&
    saved.workspaces !== null
  ) {
    if ("dialect" in saved && PLAYGROUND_DIALECTS.includes(saved.dialect as PlaygroundDialect))
      state.dialect = saved.dialect as PlaygroundDialect;
    for (const dialect of PLAYGROUND_DIALECTS) {
      const record = (saved.workspaces as Record<string, unknown>)[dialect];
      if (typeof record === "object" && record !== null && "files" in record && validWorkspaceFiles(record.files))
        state.workspaces[dialect] = { files: { ...record.files }, example: identifyExample(dialect, record.files) };
    }
  } else if (typeof legacy === "object" && legacy !== null) {
    for (const dialect of PLAYGROUND_DIALECTS) {
      const files = (legacy as Record<string, unknown>)[dialect];
      if (validWorkspaceFiles(files)) state.workspaces[dialect] = upgradeLegacyWorkspace(dialect, files);
    }
  }
  return state;
}

export function decodeSharedWorkspace(
  value: unknown,
): { dialect: PlaygroundDialect; workspace: StoredWorkspace } | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("dialect" in value) ||
    !("files" in value) ||
    !PLAYGROUND_DIALECTS.includes(value.dialect as PlaygroundDialect) ||
    !validWorkspaceFiles(value.files)
  )
    return undefined;
  const dialect = value.dialect as PlaygroundDialect;
  // Shared snapshots are exact user input; never inject files or migrate their sources.
  return { dialect, workspace: { files: { ...value.files }, example: identifyExample(dialect, value.files) } };
}
