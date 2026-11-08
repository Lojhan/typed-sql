import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { consumer } from "../build/src/consumer.mjs";
import { qualifyPackedContracts } from "./contracts-packed.mjs";
import { firstUse } from "./first-use.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const output = resolve(directory, `../../artifacts/sqlserver/packed-${process.env.TYPED_SQL_SQLSERVER_MAJOR}.log`);
const fixture = await consumer(
  ["koffi", "typescript", "@types/node", "esbuild"],
  ["@typed-sql/sqlserver", "@typed-sql/compiler", "@typed-sql/cli", "@typed-sql/language-server"],
);
try {
  const application = join(fixture.directory, "application");
  await mkdir(application);
  await cp(join(directory, "packed-consumer.mjs"), join(application, "consumer.mjs"));
  const result = await fixture.command(application, process.execPath, ["consumer.mjs"], { timeout: 90000 });
  await writeFile(output, result.output);
  const types = await fixture.command(application, "pnpm", [
    "exec",
    "tsc",
    "--strict",
    "--noEmit",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2024",
    "--skipLibCheck",
    "type-proof.ts",
  ]);
  await writeFile(output.replace(/\.log$/u, "-types.log"), types.output);
  console.log("Packed native SQL Server workers and execution passed");
  await firstUse(fixture);
  await qualifyPackedContracts(fixture);
} catch (error) {
  const password = process.env.TYPED_SQL_SQLSERVER_PASSWORD;
  const message = password ? String(error).replaceAll(password, "[redacted]") : String(error);
  await writeFile(output, message);
  throw new Error(message);
} finally {
  await fixture.close();
}
