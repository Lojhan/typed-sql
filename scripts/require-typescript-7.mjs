import { readFile } from "node:fs/promises";

const packageUrl = new URL("../node_modules/typescript/package.json", import.meta.url);
const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));

if (!String(packageJson.version).startsWith("7.")) {
  throw new Error(`typed-sql requires TypeScript 7.x; found ${packageJson.version}`);
}
