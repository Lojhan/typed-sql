import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await rm(resolve(root, "dist/ui"), { recursive: true, force: true });
await mkdir(resolve(root, "dist/ui"), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["ui/app.tsx"],
  bundle: true,
  minify: true,
  sourcemap: false,
  platform: "browser",
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  outdir: "dist/ui",
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "eof",
});
await writeFile(
  resolve(root, "dist/ui/index.html"),
  '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>typed-sql · Dev workspace</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>\n',
);
