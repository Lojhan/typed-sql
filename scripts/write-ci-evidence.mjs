import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const arguments_ = process.argv.slice(2);
const value = (flag) => {
  const index = arguments_.indexOf(flag);
  return index < 0 ? undefined : arguments_[index + 1];
};
const lane = value("--lane");
const output = value("--output");
const gates = arguments_
  .flatMap((argument, index) => (argument === "--gate" ? [arguments_[index + 1]] : []))
  .filter(Boolean);
if (!lane || !output || gates.length === 0)
  throw new TypeError("CI evidence requires --lane, --output, and at least one --gate");
if (!/^[a-z][a-z-]*$/u.test(lane) || gates.some((gate) => !/^[a-z][a-z-]*$/u.test(gate)))
  throw new TypeError("CI evidence names must use lowercase words and hyphens");

const path = resolve(output);
await mkdir(dirname(path), { recursive: true });
await writeFile(
  path,
  `${JSON.stringify(
    {
      formatVersion: 1,
      lane,
      target: process.env.TYPED_SQL_MATRIX_TARGET ?? "repository",
      revision: process.env.GITHUB_SHA ?? "local",
      run: process.env.GITHUB_RUN_ID ?? "local",
      attempt: process.env.GITHUB_RUN_ATTEMPT ?? "local",
      gates: [...new Set(gates)].sort(),
    },
    null,
    2,
  )}\n`,
);
