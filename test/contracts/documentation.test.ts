import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { type CompiledQuery, compileSource } from "../../packages/compiler/src/index.js";
import type { DialectPlugin, SchemaSnapshot } from "../../packages/core/src/index.js";
import { mysql } from "../../packages/mysql/src/index.js";
import { postgres } from "../../packages/postgres/src/index.js";
import { loadSchemaSnapshot } from "../../packages/schema/src/index.js";
import { sqlite } from "../../packages/sqlite/src/index.js";
import { queryHovers } from "../../website/.vitepress/theme/playground/editor-support.js";
import {
  analyzePlayground,
  DEFAULT_SCHEMAS,
  DEFAULT_SOURCES,
  PLAYGROUND_DIALECTS,
} from "../../website/.vitepress/theme/playground/playground.js";
import {
  analyzePostgresPlayground,
  DEFAULT_PLAYGROUND_SCHEMA,
  DEFAULT_PLAYGROUND_SOURCE,
} from "../../website/.vitepress/theme/playground/postgres-playground.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const pageTypes = ["landing", "tutorial", "how-to", "explanation", "reference", "migration"] as const;
type PageType = (typeof pageTypes)[number];

interface NavigationPage {
  readonly text: string;
  readonly link: string;
  readonly file: string;
  readonly pageType: PageType;
  readonly packageName?: string;
  readonly status?: "stable" | "experimental";
}

interface NavigationManifest {
  readonly topNavigation: readonly { readonly text: string; readonly link: string }[];
  readonly sections: readonly {
    readonly text: string;
    readonly collapsed?: boolean;
    readonly items: readonly NavigationPage[];
  }[];
}

interface DocumentationRedirect {
  readonly from: `/${string}`;
  readonly to: `/${string}`;
}

const navigationManifest = JSON.parse(
  readFileSync(join(workspace, "website/.vitepress/navigation.json"), "utf8"),
) as NavigationManifest;
const documentationSections = navigationManifest.sections;
const publicDocumentationPages = documentationSections.flatMap(({ items }) => items);
const dialectNavigation = (documentationSections.find(({ text }) => text === "Dialects")?.items ?? [])
  .filter(({ packageName, status }) => packageName !== undefined || status !== undefined)
  .map((page) => {
    if (page.packageName === undefined || page.status === undefined) {
      throw new Error(`${page.file} needs packageName and status dialect metadata`);
    }
    return { ...page, packageName: page.packageName, status: page.status };
  });
const documentationRedirects = JSON.parse(
  readFileSync(join(workspace, "website/.vitepress/redirects.json"), "utf8"),
) as readonly DocumentationRedirect[];

const expectedPublicDocs = publicDocumentationPages.map(({ file }) => file).sort();

const deletedPublicDocs = [
  "ARCHITECTURE.md",
  "CODEC_FIDELITY.md",
  "COMPATIBILITY.md",
  "GRAMMAR_AUTHORING.md",
  "PERFORMANCE.md",
  "PUBLIC_API.md",
  "REGISTRY_ACCEPTANCE.md",
  "RELEASING.md",
  "SOUNDNESS.md",
  "STABLE_REHEARSAL.md",
  "STABLE_RELEASE_PLAN.md",
] as const;

async function text(path: string): Promise<string> {
  return readFile(join(workspace, path), "utf8");
}

async function markdownFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(join(workspace, directory), { withFileTypes: true });

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path.replaceAll("\\", "/"));
    }
  }

  return files.sort();
}

function withoutFencedCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/gu, "");
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sourceSnippet(source: string, name: string): string {
  const escapedName = escapedRegExp(name);
  const match = source.match(
    new RegExp(`// docs:start ${escapedName}\\n([\\s\\S]*?)\\n// docs:end ${escapedName}`, "u"),
  );
  const snippet = match?.[1];
  strict.ok(snippet, `source snippet ${name} is missing or empty`);
  return snippet?.trim() ?? "";
}

function markdownSnippet(markdown: string, name: string): string {
  const escapedName = escapedRegExp(name);
  const fence = "```";
  const match = markdown.match(
    new RegExp(
      `<!-- docs:start ${escapedName} -->\\n${fence}ts\\n([\\s\\S]*?)\\n${fence}\\n<!-- docs:end ${escapedName} -->`,
      "u",
    ),
  );
  const snippet = match?.[1];
  strict.ok(snippet, `Markdown snippet ${name} is missing or empty`);
  return snippet?.trim() ?? "";
}

async function assertSourceBackedQuery<Snapshot extends SchemaSnapshot, Policy>(options: {
  readonly documentationPath: string;
  readonly sourcePath: string;
  readonly schemaPath: string;
  readonly sourceSnippetName: string;
  readonly contractSnippetName: string;
  readonly dialect: DialectPlugin<Snapshot, Policy>;
  readonly displayedParameterType?: string;
  readonly contractTypeName?: string;
  readonly contractBindingName?: string;
}): Promise<CompiledQuery> {
  const source = await text(options.sourcePath);
  const documentation = await text(options.documentationPath);
  strict.strictEqual(
    markdownSnippet(documentation, options.sourceSnippetName),
    sourceSnippet(source, options.sourceSnippetName),
  );

  const schema = (await loadSchemaSnapshot(join(workspace, options.schemaPath))) as Snapshot;
  const compilation = compileSource({ source, schema, dialect: options.dialect });
  strict.deepStrictEqual(compilation.diagnostics, []);
  strict.strictEqual(compilation.queries.length, 1);
  const query = compilation.queries[0];
  if (!query) strict.fail(`${options.sourcePath} did not compile a query`);
  strict.strictEqual(
    markdownSnippet(documentation, options.contractSnippetName),
    [
      options.contractBindingName === undefined
        ? `type ${options.contractTypeName ?? "AccountByIdQuery"} = Query<`
        : `const ${options.contractBindingName}: Query<`,
      `  ${query.rowType},`,
      `  ${options.displayedParameterType ?? query.parameterType}`,
      ">;",
    ].join("\n"),
  );
  return query;
}

function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  const counts = new Map<string, number>();

  for (const match of withoutFencedCode(markdown).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)) {
    const base = (match[1] ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .trim()
      .replace(/\s+/gu, "-");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }

  return slugs;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function assertLocalLinks(path: string): Promise<void> {
  const markdown = withoutFencedCode(await text(path));

  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/gu)) {
    const destination = match[1] ?? "";
    if (/^(?:https?:|mailto:|#)/u.test(destination)) continue;

    const [encodedTarget, encodedAnchor] = destination.split("#", 2);
    const target = decodeURIComponent(encodedTarget ?? "");
    const absoluteTarget = resolve(workspace, dirname(path), target);
    strict.ok(await exists(absoluteTarget), `${path} links to missing ${destination}`);

    if (encodedAnchor && target.endsWith(".md")) {
      const targetMarkdown = await readFile(absoluteTarget, "utf8");
      const anchor = decodeURIComponent(encodedAnchor).toLowerCase();
      strict.ok(headingSlugs(targetMarkdown).has(anchor), `${path} links to missing heading ${destination}`);
    }
  }
}

await describe("public documentation", async () => {
  await it("keeps one intentional, durable information architecture", async () => {
    strict.deepStrictEqual(await markdownFiles("docs"), [...expectedPublicDocs]);

    const files = publicDocumentationPages.map(({ file }) => file);
    const links = publicDocumentationPages.map(({ link }) => link);
    strict.strictEqual(new Set(files).size, files.length, "each public document must appear in navigation once");
    strict.strictEqual(new Set(links).size, links.length, "each public route must appear in navigation once");

    for (const path of expectedPublicDocs) {
      const markdown = await text(path);
      const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---\n/u)?.[1] ?? "";
      strict.match(frontmatter, /^title:\s+\S.+$/mu, `${path} needs a title`);
      strict.match(frontmatter, /^description:\s+\S.+$/mu, `${path} needs a description`);
      const declaredPageType = frontmatter.match(/^pageType:\s+(\S+)\s*$/mu)?.[1];
      const navigationPage = publicDocumentationPages.find(({ file }) => file === path);
      if (!navigationPage) throw new Error(`${path} is missing navigation metadata`);
      strict.ok(pageTypes.includes(navigationPage.pageType), `${path} has invalid navigation pageType`);
      strict.ok(declaredPageType, `${path} needs a pageType`);
      strict.ok(pageTypes.includes(declaredPageType as (typeof pageTypes)[number]), `${path} has invalid pageType`);
      strict.strictEqual(declaredPageType, navigationPage.pageType, `${path} pageType differs from navigation`);
      strict.strictEqual(
        [...withoutFencedCode(markdown).matchAll(/^#\s+.+$/gmu)].length,
        1,
        `${path} must contain exactly one H1`,
      );
    }
  });

  await it("keeps navigation status and future route moves explicit", async () => {
    const manifest = JSON.parse(await text("release-manifest.json")) as {
      readonly packagePolicy: {
        readonly stable: readonly string[];
        readonly experimental: readonly string[];
      };
    };

    for (const dialect of dialectNavigation) {
      const expectedStatus = manifest.packagePolicy.stable.includes(dialect.packageName)
        ? "stable"
        : manifest.packagePolicy.experimental.includes(dialect.packageName)
          ? "experimental"
          : undefined;
      strict.ok(expectedStatus, `${dialect.packageName} is missing from release package policy`);
      strict.strictEqual(dialect.status, expectedStatus, `${dialect.packageName} navigation status is stale`);
      if (expectedStatus === "stable") {
        strict.doesNotMatch(dialect.text, /preview|experimental/iu, `${dialect.text} incorrectly appears provisional`);
      }
      strict.match(await text(dialect.file), new RegExp(`\\b${expectedStatus}\\b`, "iu"));
    }

    const redirectSources = new Set<string>();
    const publicRoutes = new Set(publicDocumentationPages.map(({ link }) => link));
    for (const redirect of documentationRedirects) {
      strict.notStrictEqual(redirect.from, redirect.to, `${redirect.from} redirects to itself`);
      strict.ok(!redirectSources.has(redirect.from), `${redirect.from} has more than one redirect`);
      strict.ok(publicRoutes.has(redirect.to), `${redirect.from} redirects to unknown route ${redirect.to}`);
      redirectSources.add(redirect.from);
    }

    strict.ok(documentationSections.length > 0, "documentation needs at least one navigation section");
  });

  await it("keeps every local documentation link valid", async () => {
    const packageReadmes = await markdownFiles("packages");
    const linkedMarkdown = [
      ...expectedPublicDocs,
      "README.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "editors/zed/README.md",
      ...packageReadmes.filter((path) => path.endsWith("/README.md")),
    ];

    for (const path of linkedMarkdown) await assertLocalLinks(path);
  });

  await it("keeps published code snippets aligned with executable source", async () => {
    const postgresEvidence = {
      sourcePath: "examples/postgres/src/documentation.ts",
      schemaPath: "examples/postgres/generated/db/schema.json",
      sourceSnippetName: "homepage-postgres-query",
      contractSnippetName: "homepage-postgres-contract",
      dialect: postgres(),
    } as const;
    for (const documentationPath of [
      "docs/index.md",
      "docs/getting-started/postgresql.md",
      "docs/getting-started/first-query.md",
    ]) {
      await assertSourceBackedQuery({
        documentationPath,
        ...postgresEvidence,
        ...(documentationPath === "docs/index.md" ? { contractBindingName: "accountById" } : {}),
      });
    }

    await assertSourceBackedQuery({
      documentationPath: "docs/getting-started/mysql.md",
      sourcePath: "examples/mysql/src/documentation.ts",
      schemaPath: "examples/mysql/generated/db/schema.json",
      sourceSnippetName: "quickstart-mysql-query",
      contractSnippetName: "quickstart-mysql-contract",
      dialect: mysql(),
    });
    await assertSourceBackedQuery({
      documentationPath: "docs/getting-started/sqlite.md",
      sourcePath: "examples/sqlite/src/documentation.ts",
      schemaPath: "examples/sqlite/generated/db/schema.json",
      sourceSnippetName: "quickstart-sqlite-query",
      contractSnippetName: "quickstart-sqlite-contract",
      dialect: sqlite(),
    });

    const repeatedInsert = await assertSourceBackedQuery({
      documentationPath: "docs/examples/multi-row-insert.md",
      sourcePath: "examples/postgres/src/multi-row-documentation.ts",
      schemaPath: "examples/postgres/generated/db/schema.json",
      sourceSnippetName: "postgres-multi-row-insert",
      contractSnippetName: "postgres-multi-row-contract",
      dialect: postgres(),
      displayedParameterType: "readonly (string | bigint)[]",
      contractTypeName: "InsertUsersQuery",
    });
    strict.strictEqual(repeatedInsert.fragmentList, true);
    strict.strictEqual(repeatedInsert.parameterType, "readonly unknown[]");
    strict.strictEqual(repeatedInsert.repeatedFragments?.[0]?.separator.text, ", ");
    strict.deepStrictEqual(
      repeatedInsert.repeatedFragments?.[0]?.parameterPattern.map(({ tsType }) => tsType),
      ["bigint", "string", '"active" | "suspended"'],
    );
  });

  await it("keeps every dialect quickstart on the shared first-success path", async () => {
    const expectedHeadings = [
      "1. Check the prerequisites",
      "2. Install the packages",
      "3. Create a minimal table",
      "4. Create a minimal config",
      "5. Generate the snapshot",
      "6. Write one parameterized query",
      "7. Check the inferred contract",
      "8. Execute the query",
      "9. Confirm a type error",
      "10. Choose the next step",
      "What just happened?",
    ];

    for (const dialect of ["postgresql", "mysql", "sqlite"]) {
      const markdown = withoutFencedCode(await text(`docs/getting-started/${dialect}.md`));
      const headings = [...markdown.matchAll(/^##\s+(.+?)\s*#*\s*$/gmu)].map((match) => match[1]);
      strict.deepStrictEqual(headings, expectedHeadings, `${dialect} quickstart differs from the shared path`);
    }
  });

  await it("rejects transient release narratives and retired documentation paths", async () => {
    const packageReadmes = (await markdownFiles("packages")).filter((path) => path.endsWith("/README.md"));
    const publicEntrypoints = [...expectedPublicDocs, "README.md", "editors/zed/README.md", ...packageReadmes];
    const transientPatterns = [
      /@next\b/u,
      /\.typed-sql-issue-drafts/u,
      /\bstable 1\.0\b/iu,
      /\bfirst stable release\b/iu,
      /\bpublic beta\b/iu,
      /\brelease candidate\b/iu,
      /release-manifest\.json/u,
      /release:rehearse/u,
    ];

    for (const path of publicEntrypoints) {
      const markdown = await text(path);
      for (const pattern of transientPatterns) {
        strict.ok(!pattern.test(markdown), `${path} contains transient release language: ${pattern}`);
      }
      for (const retired of deletedPublicDocs) {
        strict.ok(!markdown.includes(retired), `${path} references retired docs/${retired}`);
      }
    }
  });

  await it("documents package tracks, public adapter subpaths, and executables", async () => {
    const manifest = JSON.parse(await text("release-manifest.json")) as {
      readonly packagePolicy: {
        readonly stable: readonly string[];
        readonly experimental: readonly string[];
      };
    };
    const compatibility = await text("docs/reference/compatibility.md");

    for (const [track, packages] of Object.entries(manifest.packagePolicy)) {
      for (const packageName of packages) {
        const shortName = packageName.slice("@typed-sql/".length);
        strict.ok(compatibility.includes(`\`${shortName}\``), `${packageName} is missing from compatibility`);
        const readme = await text(`packages/${shortName}/README.md`);
        strict.match(readme, new RegExp(`\\b${track}\\b`, "iu"), `${packageName} must document its track`);
      }
    }

    for (const [packageName, guide] of [
      ["@typed-sql/postgres", "docs/dialects/postgresql.md"],
      ["@typed-sql/mysql", "docs/dialects/mysql.md"],
      ["@typed-sql/sqlite", "docs/dialects/sqlite.md"],
    ] as const) {
      const packageDirectory = packageName.slice("@typed-sql/".length);
      const packageJson = JSON.parse(await text(`packages/${packageDirectory}/package.json`)) as {
        readonly exports: Readonly<Record<string, string>>;
      };
      const documentation = await text(guide);
      for (const subpath of Object.keys(packageJson.exports)) {
        const entrypoint = subpath === "." ? packageName : `${packageName}${subpath.slice(1)}`;
        strict.ok(documentation.includes(`\`${entrypoint}\``), `${entrypoint} is missing from ${guide}`);
      }
    }

    const cliPackage = JSON.parse(await text("packages/cli/package.json")) as {
      readonly bin: Readonly<Record<string, string>>;
    };
    const languageServerPackage = JSON.parse(await text("packages/language-server/package.json")) as {
      readonly bin: Readonly<Record<string, string>>;
    };
    strict.ok((await text("packages/cli/README.md")).includes(Object.keys(cliPackage.bin)[0] ?? "missing-cli"));
    strict.ok(
      (await text("packages/language-server/README.md")).includes(
        Object.keys(languageServerPackage.bin)[0] ?? "missing-language-server",
      ),
    );
  });

  await it("keeps the v1 upgrade contract aligned with public version boundaries", async () => {
    const migration = await text("docs/guides/upgrading-from-v1.md");
    const customGrammars = await text("docs/extending/custom-grammars.md");
    const compatibility = await text("docs/guides/migration-compatibility.md");

    for (const boundary of [
      "DIALECT_CONTRACT_VERSION",
      "QUERY_SEMANTICS_VERSION",
      "SCHEMA_FORMAT_VERSION",
      "QUERY_MANIFEST_FORMAT_VERSION",
      "QUERY_FINGERPRINT_ALGORITHM",
      "QUERY_VERIFICATION_FORMAT_VERSION",
      "QUERY_VERIFIER_VERSION",
      "QUERY_PLAN_FORMAT_VERSION",
      "QUERY_PLAN_CAPTURE_VERSION",
      "QUERY_PLAN_REVIEW_FORMAT_VERSION",
      "SCHEMA_COMPATIBILITY_FORMAT_VERSION",
      "SCHEMA_COMPATIBILITY_ANALYZER_VERSION",
      "GRAMMAR_CONFORMANCE_VERSION",
      "adapterVersion",
    ]) {
      strict.ok(migration.includes(`\`${boundary}\``), `upgrade guide is missing ${boundary}`);
    }

    for (const durableInvariant of [
      'from "@typed-sql/postgres"',
      'from "@typed-sql/postgres/pg"',
      "application-owned dependencies",
      "unknownQuerySemantics()",
      "compiler inputs",
    ]) {
      strict.ok(migration.includes(durableInvariant), `upgrade guide is missing ${durableInvariant}`);
    }

    strict.ok(customGrammars.includes("../guides/upgrading-from-v1.md#upgrade-a-custom-grammar"));
    strict.ok(compatibility.includes("./upgrading-from-v1.md#adopt-compiler-and-ci-artifacts"));
  });

  await it("renders the canonical docs through a reproducible GitHub Pages site", async () => {
    const rootPackage = JSON.parse(await text("package.json")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    const websitePackage = JSON.parse(await text("website/package.json")) as {
      readonly name: string;
      readonly private: boolean;
      readonly type?: string;
      readonly dependencies: Readonly<Record<string, string>>;
      readonly devDependencies: Readonly<Record<string, string>>;
    };
    const workspaceConfig = await text("pnpm-workspace.yaml");
    const siteConfig = await text("website/.vitepress/config.mts");
    const siteTheme = await text("website/.vitepress/theme/index.ts");
    const siteStyles = await text("website/.vitepress/theme/custom.css");
    const codeEditor = await text("website/.vitepress/theme/components/CodeEditor.vue");
    const queryTypeDemo = await text("website/.vitepress/theme/components/QueryTypeDemo.vue");
    const liveQueryEditor = await text("website/.vitepress/theme/components/LiveQueryEditor.vue");
    const schemaWorkspace = await text("website/.vitepress/theme/components/SchemaWorkspace.vue");
    const schemaLauncher = await text("website/.vitepress/theme/components/SchemaWorkspaceLauncher.vue");
    const schemaStore = await text("website/.vitepress/theme/playground/schema-store.ts");
    const sqlPlayground = await text("website/.vitepress/theme/components/SqlPlayground.vue");
    const pagesWorkflow = await text(".github/workflows/pages.yml");

    strict.strictEqual(websitePackage.name, "typed-sql-docs");
    strict.strictEqual(websitePackage.private, true);
    strict.strictEqual(websitePackage.type, "module");
    for (const packageName of [
      "@typed-sql/compiler",
      "@typed-sql/core",
      "@typed-sql/mysql",
      "@typed-sql/postgres",
      "@typed-sql/sqlite",
    ]) {
      strict.strictEqual(websitePackage.dependencies[packageName], "workspace:*");
    }
    for (const packageName of [
      "@codemirror/commands",
      "@codemirror/lang-javascript",
      "@codemirror/lang-sql",
      "@codemirror/language",
      "@codemirror/lint",
      "@codemirror/state",
      "@codemirror/theme-one-dark",
      "@codemirror/view",
    ]) {
      strict.ok(websitePackage.dependencies[packageName], `website is missing ${packageName}`);
    }
    strict.strictEqual(websitePackage.devDependencies.vitepress, "1.6.4");
    strict.match(workspaceConfig, /^\s*- website$/mu);
    strict.match(workspaceConfig, /^\s+vitepress>vite:\s+6\.4\.3$/mu);
    strict.strictEqual(rootPackage.scripts["docs:start"], "pnpm --filter typed-sql-docs start");
    strict.strictEqual(rootPackage.scripts["docs:build"], "pnpm --filter typed-sql-docs build");
    strict.ok(rootPackage.scripts.verify?.includes("pnpm docs:build"));

    for (const contract of [
      'base: "/typed-sql/"',
      'srcDir: "../docs"',
      "cleanUrls: true",
      'provider: "local"',
      'pattern: "https://github.com/Lojhan/typed-sql/edit/main/docs/:path"',
    ]) {
      strict.ok(siteConfig.includes(contract), `website config is missing ${contract}`);
    }

    strict.ok(siteConfig.includes("documentationSidebar"));
    strict.ok(siteConfig.includes("topNavigation"));
    strict.ok(siteConfig.includes('publicDir: fileURLToPath(new URL("../public", import.meta.url))'));
    strict.ok(siteConfig.includes('logo: "/brand-mark.svg"'));
    strict.ok(siteConfig.includes('href: "/typed-sql/brand-mark.svg"'));
    strict.ok(siteConfig.includes('name: "typed-sql-playground-runtime"'));
    strict.ok(await exists("website/public/brand-mark.svg"));

    for (const component of ["CodeResult", "HomeHero", "NextSteps", "StatusBadge", "StepFlow"]) {
      strict.ok(siteTheme.includes(`app.component("${component}"`), `website theme is missing ${component}`);
    }
    strict.ok(siteTheme.includes('"QueryTypeDemo"'));
    strict.ok(siteTheme.includes('"SqlPlayground"'));
    strict.ok(siteTheme.includes('"LiveQueryExample"'));
    strict.ok(siteTheme.includes("defineAsyncComponent"));
    for (const interaction of ["LiveQueryEditor", 'size="hero"']) {
      strict.ok(queryTypeDemo.includes(interaction), `query type demo is missing ${interaction}`);
    }
    for (const interaction of [
      "hoverTooltip",
      "lintGutter",
      "setDiagnostics",
      "EditorView",
      "appearance.reconfigure",
    ]) {
      strict.ok(codeEditor.includes(interaction), `code editor is missing ${interaction}`);
    }
    for (const interaction of ["LiveQueryEditor", "PLAYGROUND_DIALECTS", 'size="large"']) {
      strict.ok(sqlPlayground.includes(interaction), `SQL playground is missing ${interaction}`);
    }
    strict.ok(!sqlPlayground.includes("source-label="), "SQL playground must not render inert analysis chrome");
    for (const interaction of [':diagnostics="diagnostics"', ':hovers="hovers"', "analyzePlayground"]) {
      strict.ok(liveQueryEditor.includes(interaction), `live query editor is missing ${interaction}`);
    }
    strict.ok(!liveQueryEditor.includes("<button"), "live query editors must use the global schema launcher");
    for (const interaction of ["<dialog", "Restore default", "Apply changes", 'aria-label="Close schema workspace"']) {
      strict.ok(schemaWorkspace.includes(interaction), `schema workspace is missing ${interaction}`);
    }
    strict.ok(schemaLauncher.includes('class="ts-schema-trigger"'));
    strict.ok(schemaLauncher.includes("defineAsyncComponent"));
    strict.ok(schemaStore.includes("window.localStorage"));
    strict.ok(schemaStore.includes("typed-sql.docs.schemas.v1"));
    strict.ok(!sqlPlayground.includes("ts-playground__results"), "SQL playground must not duplicate editor analysis");
    strict.ok(siteTheme.includes('from "./SiteLayout.vue"'));
    for (const stylesheet of ["tokens.css", "base.css", "components.css"]) {
      strict.ok(siteStyles.includes(stylesheet), `website theme is missing ${stylesheet}`);
    }

    for (const action of [
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b",
      "actions/upload-pages-artifact@7b1f4a764d45c48632c6b24a0339c27f5614fb0b",
      "actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e",
    ]) {
      strict.ok(pagesWorkflow.includes(action), `.github/workflows/pages.yml must pin ${action}`);
    }
    for (const contract of [
      "branches: [main]",
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "pnpm docs:build",
      "path: website/.vitepress/dist",
      "name: github-pages",
      "pages: write",
      "id-token: write",
    ]) {
      strict.ok(pagesWorkflow.includes(contract), `.github/workflows/pages.yml is missing ${contract}`);
    }
    strict.ok(
      pagesWorkflow.indexOf("pnpm build") < pagesWorkflow.indexOf("pnpm docs:build"),
      ".github/workflows/pages.yml must build workspace dependencies before the documentation site",
    );
  });

  await it("runs the homepage playground through the PostgreSQL grammar", () => {
    const valid = analyzePostgresPlayground(DEFAULT_PLAYGROUND_SCHEMA, DEFAULT_PLAYGROUND_SOURCE);
    strict.deepStrictEqual(valid.diagnostics, []);
    strict.strictEqual(valid.queries.length, 1);
    strict.strictEqual(valid.queries[0]?.binding, "accountById");
    strict.strictEqual(
      valid.queries[0]?.rowType,
      '{ "id": bigint; "email": string; "status": "active" | "suspended"; }',
    );
    strict.strictEqual(valid.queries[0]?.parameterType, "readonly [bigint]");

    const invalidQuery = analyzePostgresPlayground(
      DEFAULT_PLAYGROUND_SCHEMA,
      DEFAULT_PLAYGROUND_SOURCE.replace("account.email", "account.emali"),
    );
    strict.strictEqual(invalidQuery.queries.length, 0);
    strict.strictEqual(invalidQuery.diagnostics[0]?.file, "main.ts");
    strict.strictEqual(invalidQuery.diagnostics[0]?.code, "TSQ101");
    strict.match(invalidQuery.diagnostics[0]?.suggestion ?? "", /email/u);

    const invalidSchema = analyzePostgresPlayground("CREATE TABLE users (id);", DEFAULT_PLAYGROUND_SOURCE);
    strict.strictEqual(invalidSchema.queries.length, 0);
    strict.strictEqual(invalidSchema.diagnostics[0]?.file, "schema.sql");
    strict.strictEqual(invalidSchema.diagnostics[0]?.code, "PLAY006");

    for (const dialect of PLAYGROUND_DIALECTS) {
      const result = analyzePlayground(dialect, DEFAULT_SCHEMAS[dialect], DEFAULT_SOURCES[dialect]);
      strict.deepStrictEqual(result.diagnostics, []);
      strict.strictEqual(result.queries.length, 1);
      strict.strictEqual(result.queries[0]?.binding, "accountById");
      strict.strictEqual(result.queries[0]?.parameterType, "readonly [bigint]");
    }
    strict.ok(!DEFAULT_SCHEMAS.sqlite.includes("CREATE TABLE accounts"));

    const executionSource = `${DEFAULT_PLAYGROUND_SOURCE}\n\nconst rows = await database.execute(accountById);\nrows[0];`;
    const execution = analyzePostgresPlayground(DEFAULT_PLAYGROUND_SCHEMA, executionSource);
    const hovers = queryHovers(executionSource, execution.queries);
    strict.ok(
      hovers.some(
        ({ from, to, content }) =>
          executionSource.slice(from, to) === "rows[0]" &&
          content === '(element) rows[0]: { "id": bigint; "email": string; "status": "active" | "suspended"; }',
      ),
      "adapter result indexing must expose the inferred row type",
    );
  });

  await it("keeps every live documentation example valid against its shared default schema", async () => {
    let count = 0;
    const pattern =
      /<LiveQueryExample dialect="(postgres|mysql|sqlite)"[^>]*>[\s\S]*?```ts\n([\s\S]*?)\n```[\s\S]*?<\/LiveQueryExample>/gu;
    for (const path of expectedPublicDocs) {
      const markdown = await text(path);
      for (const match of markdown.matchAll(pattern)) {
        const dialect = match[1] as (typeof PLAYGROUND_DIALECTS)[number];
        const source = match[2] ?? "";
        const result = analyzePlayground(dialect, DEFAULT_SCHEMAS[dialect], source);
        strict.deepStrictEqual(result.diagnostics, [], `${path} has an invalid ${dialect} live example`);
        strict.ok(result.queries.length > 0, `${path} has a live example without a query`);
        count += 1;
      }
    }
    strict.strictEqual(count, 14, "the documented live-example inventory changed without updating its contract");
  });
});
