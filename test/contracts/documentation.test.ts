import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const expectedPublicDocs = [
  "docs/concepts/architecture.md",
  "docs/concepts/performance.md",
  "docs/concepts/type-safety.md",
  "docs/dialects/mysql.md",
  "docs/dialects/postgresql.md",
  "docs/extending/custom-grammars.md",
  "docs/getting-started/configuration.md",
  "docs/getting-started/first-query.md",
  "docs/getting-started/installation.md",
  "docs/guides/composition.md",
  "docs/guides/editors.md",
  "docs/guides/execution.md",
  "docs/guides/schema-snapshots.md",
  "docs/index.md",
  "docs/reference/api.md",
  "docs/reference/compatibility.md",
  "docs/reference/diagnostics.md",
  "docs/reference/type-mappings.md",
] as const;

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

function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  const counts = new Map<string, number>();

  for (const match of withoutFencedCode(markdown).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)) {
    const base = (match[1] ?? "")
      .toLowerCase()
      .replace(/<[^>]+>/gu, "")
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

    for (const path of expectedPublicDocs) {
      const markdown = await text(path);
      const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---\n/u)?.[1] ?? "";
      strict.match(frontmatter, /^title:\s+\S.+$/mu, `${path} needs a title`);
      strict.match(frontmatter, /^description:\s+\S.+$/mu, `${path} needs a description`);
      strict.strictEqual(
        [...withoutFencedCode(markdown).matchAll(/^#\s+.+$/gmu)].length,
        1,
        `${path} must contain exactly one H1`,
      );
    }
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
});
