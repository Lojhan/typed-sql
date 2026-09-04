import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { documentationSidebar, topNavigation } from "./navigation.mts";

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
    nav: topNavigation,
    sidebar: documentationSidebar,
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
