import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const grammars = {
  postgres: { package: "@typed-sql/postgres", factory: "postgres" },
  mysql: { package: "@typed-sql/mysql", factory: "mysql" },
  sqlite: { package: "@typed-sql/sqlite", factory: "sqlite" },
} as const;
const managers = ["npm", "pnpm", "yarn", "bun"] as const;
type Manager = (typeof managers)[number];
type JsonObject = Record<string, unknown>;

export interface InitFile {
  readonly path: string;
  readonly beforeHash: string | null;
  readonly content: string;
}

export interface InitPlan {
  readonly formatVersion: 1;
  readonly mode: "plan";
  readonly root: string;
  readonly packageManager: Manager;
  readonly grammar: keyof typeof grammars;
  readonly editor: "none" | "vscode" | "zed";
  readonly files: readonly InitFile[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly scripts: Readonly<Record<string, string>>;
  readonly detected: readonly string[];
  readonly pending: readonly string[];
  readonly warnings: readonly string[];
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

async function read(path: string): Promise<string | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error(`Expected a regular non-symlink file: ${path}`);
      return await file.readFile("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function manager(value: string): Manager {
  if (!managers.includes(value as Manager)) throw new Error(`Unsupported package manager: ${value}`);
  return value as Manager;
}

export async function planInit(options: Readonly<Record<string, string>>, version: string): Promise<InitPlan> {
  const allowed = new Set(["cwd", "package", "grammar", "editor", "package-manager", "dry-run", "json"]);
  for (const [key, value] of Object.entries(options)) {
    if (!allowed.has(key)) throw new Error(`Unknown init option --${key}`);
    if ((key === "dry-run" || key === "json") && value !== "true") throw new Error(`--${key} does not accept a value`);
  }
  const grammar = options.grammar as keyof typeof grammars;
  if (!Object.hasOwn(grammars, grammar ?? "")) throw new Error("init requires --grammar postgres|mysql|sqlite");
  const editor = options.editor ?? "none";
  if (editor !== "none" && editor !== "vscode" && editor !== "zed")
    throw new Error("--editor must be none, vscode, or zed");
  const base = await realpath(resolve(options.cwd ?? process.cwd()));
  let root = base;
  if (options.package !== undefined) {
    const target = resolve(base, options.package);
    const path = relative(base, target);
    if (isAbsolute(options.package) || path.startsWith("..") || isAbsolute(path))
      throw new Error("--package must select a directory inside --cwd");
    let current = base;
    for (const part of path.split(/[\\/]/u).filter(Boolean)) {
      current = join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("--package cannot traverse symlinks or files");
    }
    root = target;
  }
  const manifestText = await read(join(root, "package.json"));
  const manifest =
    manifestText === undefined ? { private: true, type: "module" } : object(JSON.parse(manifestText), "package.json");
  if (
    (manifest.workspaces !== undefined || (await read(join(root, "pnpm-workspace.yaml"))) !== undefined) &&
    options.package === undefined
  )
    throw new Error("Workspace root is ambiguous; select an application with --package");
  const detected: string[] = [];
  const candidates = new Set<Manager>();
  for (let directory = root; ; directory = dirname(directory)) {
    const parentText = directory === root ? manifestText : await read(join(directory, "package.json"));
    const parent = parentText === undefined ? {} : object(JSON.parse(parentText), "package.json");
    if (parent.packageManager !== undefined) {
      if (typeof parent.packageManager !== "string" || !/^(npm|pnpm|yarn|bun)@[^\s]+$/u.test(parent.packageManager))
        throw new Error(`Invalid packageManager in ${directory}`);
      candidates.add(manager(parent.packageManager.split("@")[0]!));
    }
    for (const [file, name] of [
      ["package-lock.json", "npm"],
      ["npm-shrinkwrap.json", "npm"],
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["bun.lock", "bun"],
      ["bun.lockb", "bun"],
    ] as const) {
      if ((await read(join(directory, file))) !== undefined) {
        candidates.add(name);
        detected.push(join(directory, file));
      }
    }
    if (
      parent.workspaces !== undefined ||
      (await read(join(directory, "pnpm-workspace.yaml"))) !== undefined ||
      dirname(directory) === directory
    )
      break;
  }
  if (options["package-manager"] !== undefined) candidates.add(manager(options["package-manager"]));
  if (candidates.size > 1) throw new Error(`Conflicting package managers: ${[...candidates].sort().join(", ")}`);
  const packageManager = [...candidates][0] ?? "npm";
  const dependencies: Record<string, string> = {};
  const existing = {
    ...object(manifest.devDependencies ?? {}, "devDependencies"),
    ...object(manifest.dependencies ?? {}, "dependencies"),
  };
  for (const [name, range] of [
    ["@typed-sql/cli", `^${version}`],
    ["@typed-sql/core", "^2.1.0"],
    [grammars[grammar].package, "^2.1.0"],
    ["typescript", "~7.0.2"],
  ] as const) {
    const value = existing[name];
    if (value !== undefined && typeof value !== "string") throw new Error(`Invalid dependency ${name}`);
    if (value === undefined) dependencies[name] = range;
  }
  const files: InitFile[] = [];
  const add = (path: string, content: string, before?: string) =>
    files.push({
      path: join(root, path),
      beforeHash: before === undefined ? null : createHash("sha256").update(before).digest("hex"),
      content,
    });
  const warnings: string[] = [];
  if (Object.keys(existing).length > 0)
    warnings.push(
      "Existing dependency ranges are preserved; compatibility and registry availability have not been checked.",
    );
  const scripts: Record<string, string> = {};
  const existingScripts = object(manifest.scripts ?? {}, "scripts");
  for (const [name, command] of [
    ["typed-sql:generate", "typed-sql generate"],
    ["typed-sql:check", "typed-sql check"],
  ] as const) {
    if (existingScripts[name] === undefined) scripts[name] = command;
    else if (existingScripts[name] !== command)
      warnings.push(`Preserve existing script ${name}; proposed command is ${command}.`);
  }
  const pending = [
    "Supply or introspect a real schema snapshot, then run typed-sql generate and doctor. No database access is authorized by this plan.",
  ];
  if (Object.keys(dependencies).length > 0)
    pending.push(
      `Install the listed dependencies with ${packageManager}; installation and lifecycle scripts require separate approval.`,
    );
  if (manifestText === undefined) add("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  else detected.push(join(root, "package.json"));
  const configs = [
    "typed-sql.config.ts",
    "typed-sql.config.mts",
    "typed-sql.config.cts",
    "typed-sql.config.js",
    "typed-sql.config.mjs",
    "typed-sql.config.cjs",
  ];
  const found: string[] = [];
  for (const file of configs) if ((await read(join(root, file))) !== undefined) found.push(file);
  if (found.length > 1) throw new Error(`Multiple typed-sql configurations: ${found.join(", ")}`);
  if (found.length === 0)
    add(
      "typed-sql.config.ts",
      `import { ${grammars[grammar].factory} } from ${JSON.stringify(grammars[grammar].package)};\n\nexport default {\n  dialect: ${grammars[grammar].factory}(),\n  schema: { file: "schema.json" },\n  outDir: "generated",\n  projects: ["tsconfig.json"],\n};\n`,
    );
  else {
    detected.push(join(root, found[0]!));
    warnings.push(
      "Existing typed-sql configuration is preserved and was not executed; its grammar and paths are unverified.",
    );
  }
  for (const file of ["tsconfig.json", "schema.json"]) {
    if ((await read(join(root, file))) !== undefined) detected.push(join(root, file));
    else if (file === "tsconfig.json")
      add(
        file,
        `${JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2024", module: "NodeNext", jsx: "preserve", skipLibCheck: true }, include: ["src/**/*.ts", "src/**/*.tsx"] }, null, 2)}\n`,
      );
  }
  if (editor !== "none")
    pending.push(
      `${editor}: choose a verified TypeScript provider mode and explicitly approve experimental language-server installation. No editor settings or extensions are changed.`,
    );
  return {
    formatVersion: 1,
    mode: "plan",
    root,
    packageManager,
    grammar,
    editor,
    files,
    dependencies,
    scripts,
    detected: detected.sort(),
    pending,
    warnings,
  };
}
