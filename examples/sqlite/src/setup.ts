import { readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { databasePath } from "../typed-sql.config.js";

await rm(databasePath, { force: true });

const database = new DatabaseSync(fileURLToPath(databasePath));
try {
  database.exec(await readFile(new URL("../schema/001-schema.sql", import.meta.url), "utf8"));
} finally {
  database.close();
}
