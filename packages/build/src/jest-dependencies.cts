import version = require("./version.cjs");

import type { BuildOptions } from "./project.js";

import SynchronousSession = require("./sync.cjs");
const { createHash } = require("node:crypto") as typeof import("node:crypto");

interface Extractor {
  extract(
    source: string,
    file: string,
    extractDefault: (source: string, file: string) => Iterable<string>,
  ): Set<string>;
  getCacheKey(): string;
}
function createDependencyExtractor(options: BuildOptions = {}): Extractor {
  let session: SynchronousSession | undefined;
  return {
    extract(source, file, extractDefault) {
      const dependencies = new Set(extractDefault(source, file));
      if (file.endsWith(".sql") || source.includes("sql") || /\.sql["']/u.test(source)) {
        session ??= new SynchronousSession({
          ...options,
          cwd: options.cwd ?? process.env.TYPED_SQL_BUILD_CWD ?? process.cwd(),
          ...(options.config === undefined && process.env.TYPED_SQL_BUILD_CONFIG !== undefined
            ? { config: process.env.TYPED_SQL_BUILD_CONFIG }
            : {}),
        });
        for (const dependency of session.request("identity").dependencies) dependencies.add(dependency);
      }
      return dependencies;
    },
    getCacheKey() {
      return createHash("sha256")
        .update(`typed-sql-dependencies:1:${version}`)
        .update(JSON.stringify(options))
        .digest("hex");
    },
  };
}
export = { ...createDependencyExtractor(), createDependencyExtractor };
