import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { documentationSidebar, topNavigation } from "./navigation.mts";

const vuePackage = fileURLToPath(new URL("../node_modules/vue", import.meta.url));
const schemaBrowserRuntime = fileURLToPath(new URL("./theme/playground/schema-browser-runtime.ts", import.meta.url));
const extensionsBrowserRuntime = fileURLToPath(
  new URL("./theme/playground/extensions-browser-runtime.ts", import.meta.url),
);

export default defineConfig({
  lang: "en-US",
  title: "typed-sql",
  description: "Write SQL. Read TypeScript.",
  base: "/typed-sql/",
  srcDir: "../docs",
  cleanUrls: true,
  lastUpdated: true,
  appearance: "dark",
  head: [
    ["meta", { name: "theme-color", content: "#081318" }],
    ["link", { rel: "icon", href: "/typed-sql/brand-mark.svg", type: "image/svg+xml" }],
  ],
  markdown: {
    lineNumbers: true,
  },
  vite: {
    publicDir: fileURLToPath(new URL("../public", import.meta.url)),
    plugins: [
      {
        name: "typed-sql-playground-runtime",
        enforce: "pre",
        resolveId(source, importer) {
          if (
            source === "./extensions.js" &&
            importer?.replaceAll("\\", "/").endsWith("/packages/postgres/src/type-resolution.ts")
          ) {
            return extensionsBrowserRuntime;
          }
          return null;
        },
      },
    ],
    resolve: {
      alias: [
        { find: /^vue$/, replacement: `${vuePackage}/dist/vue.runtime.esm-bundler.js` },
        { find: /^vue\/server-renderer$/, replacement: `${vuePackage}/server-renderer/index.mjs` },
        { find: /^@typed-sql\/schema$/, replacement: schemaBrowserRuntime },
      ],
    },
  },
  themeConfig: {
    siteTitle: "typed-sql",
    logo: "/brand-mark.svg",
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
