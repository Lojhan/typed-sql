const { readFileSync } = require("node:fs") as typeof import("node:fs");
const { dirname, resolve } = require("node:path") as typeof import("node:path");
function packageVersion(): string {
  for (let directory = __dirname; ; directory = dirname(directory)) {
    try {
      const metadata = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (metadata.name === "@typed-sql/build" && metadata.version !== undefined) return metadata.version;
    } catch {}
    if (dirname(directory) === directory) throw new Error("Could not identify the typed-sql build package");
  }
}
export = packageVersion();
