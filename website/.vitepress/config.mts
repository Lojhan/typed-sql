import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

const vuePackage = fileURLToPath(new URL("../node_modules/vue", import.meta.url));

export default defineConfig({
  lang: "en-US",
  title: "typed-sql",
  description: "Write SQL. Hover the query. Get the exact row type.",
  base: "/typed-sql/",
  srcDir: "../docs",
  cleanUrls: true,
  lastUpdated: true,
  appearance: "dark",
  head: [["meta", { name: "theme-color", content: "#0b1117" }]],
  markdown: {
    lineNumbers: true,
  },
  vite: {
    resolve: {
      alias: [
        { find: /^vue$/, replacement: `${vuePackage}/dist/vue.runtime.esm-bundler.js` },
        { find: /^vue\/server-renderer$/, replacement: `${vuePackage}/server-renderer/index.mjs` },
      ],
    },
  },
  themeConfig: {
    siteTitle: "typed-sql",
    nav: [
      { text: "Documentation", link: "/" },
      { text: "Examples", link: "/examples/" },
      { text: "GitHub", link: "https://github.com/Lojhan/typed-sql" },
    ],
    sidebar: [
      {
        text: "Getting started",
        collapsed: false,
        items: [
          { text: "Overview", link: "/" },
          { text: "Installation", link: "/getting-started/installation" },
          { text: "Configuration", link: "/getting-started/configuration" },
          { text: "Your first query", link: "/getting-started/first-query" },
        ],
      },
      {
        text: "Examples",
        items: [
          { text: "Overview", link: "/examples/" },
          { text: "PostgreSQL", link: "/examples/postgresql" },
          { text: "MySQL", link: "/examples/mysql" },
          { text: "SQLite", link: "/examples/sqlite" },
          { text: "PostgreSQL + SQLite", link: "/examples/multi-database" },
        ],
      },
      {
        text: "Guides",
        items: [
          { text: "Execute queries", link: "/guides/execution" },
          { text: "Validate query results", link: "/guides/result-validation" },
          { text: "Transfer bulk data", link: "/guides/bulk-data" },
          { text: "Observe database work", link: "/guides/observability" },
          { text: "Route reads and retry transactions", link: "/guides/routing-and-retries" },
          { text: "Emit query manifests", link: "/guides/query-manifests" },
          { text: "Verify against a database", link: "/guides/live-verification" },
          { text: "Govern query plans", link: "/guides/query-plan-governance" },
          { text: "Check migration compatibility", link: "/guides/migration-compatibility" },
          { text: "Upgrade from v1", link: "/guides/upgrading-from-v1" },
          { text: "Compose conditional SQL", link: "/guides/composition" },
          { text: "Manage schema snapshots", link: "/guides/schema-snapshots" },
          { text: "Configure editors", link: "/guides/editors" },
        ],
      },
      {
        text: "Dialects",
        items: [
          { text: "PostgreSQL", link: "/dialects/postgresql" },
          { text: "MySQL", link: "/dialects/mysql" },
          { text: "SQLite (preview)", link: "/dialects/sqlite" },
        ],
      },
      {
        text: "Concepts",
        items: [
          { text: "Architecture", link: "/concepts/architecture" },
          { text: "Inference and type safety", link: "/concepts/type-safety" },
          { text: "Performance", link: "/concepts/performance" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Query API", link: "/reference/api" },
          { text: "Grammar support", link: "/reference/grammar-support" },
          { text: "Compatibility", link: "/reference/compatibility" },
          { text: "Type mappings", link: "/reference/type-mappings" },
          { text: "Diagnostics", link: "/reference/diagnostics" },
        ],
      },
      {
        text: "Extending",
        items: [{ text: "Author a custom grammar", link: "/extending/custom-grammars" }],
      },
    ],
    editLink: {
      pattern: "https://github.com/Lojhan/typed-sql/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    search: {
      provider: "local",
    },
    outline: {
      level: [2, 3],
      label: "On this page",
    },
    socialLinks: [{ icon: "github", link: "https://github.com/Lojhan/typed-sql" }],
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 typed-sql contributors.",
    },
  },
});
