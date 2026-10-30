#!/usr/bin/env node
import { parseArgs } from "node:util";
import { generateSqlTypes } from "./types.js";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      config: { type: "string" },
      include: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      check: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help)
    console.log(
      "Usage: typed-sql-build types [--cwd directory] [--config path] [--include glob] [--exclude glob] [--check]",
    );
  else {
    if (positionals.length !== 1 || positionals[0] !== "types")
      throw new Error("Expected: typed-sql-build types (use --help for options)");
    const result = await generateSqlTypes({
      ...(values.cwd === undefined ? {} : { cwd: values.cwd }),
      ...(values.config === undefined ? {} : { config: values.config }),
      ...(values.include === undefined ? {} : { include: values.include }),
      ...(values.exclude === undefined ? {} : { exclude: values.exclude }),
      ...(values.check === undefined ? {} : { check: values.check }),
    });
    console.log(
      `${values.check ? "Checked" : "Generated"} ${result.files.length} SQL declaration(s); removed ${result.removed.length} stale declaration(s).`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
