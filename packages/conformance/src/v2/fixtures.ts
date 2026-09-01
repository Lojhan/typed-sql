import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { defineConformanceProbe, defineConformanceSuite } from "./contracts.js";
import { CONFORMANCE_VERSION, type ConformanceProbe, type ConformanceSuite } from "./types.js";

async function fixturePaths(root: string, directory = root): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await fixturePaths(root, path)));
    else if (entry.isFile() && extname(entry.name) === ".json" && entry.name.endsWith(".probe.json")) paths.push(path);
  }
  return paths;
}

export async function discoverConformanceFixtures(root: string): Promise<ConformanceSuite> {
  const paths = await fixturePaths(root);
  const probes: ConformanceProbe[] = [];
  for (const path of paths) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      throw new TypeError(`Invalid conformance fixture ${relative(root, path)}: ${String(error)}`);
    }
    try {
      probes.push(defineConformanceProbe(value as ConformanceProbe));
    } catch (error) {
      throw new TypeError(`Invalid conformance fixture ${relative(root, path)}: ${String(error)}`);
    }
  }
  return defineConformanceSuite({ version: CONFORMANCE_VERSION, name: root, probes });
}

export async function minimizeConformanceSource(
  probe: ConformanceProbe,
  preservesFailure: (candidate: ConformanceProbe) => boolean | Promise<boolean>,
): Promise<ConformanceProbe> {
  let tokens = probe.source.match(/\S+\s*/gu) ?? [];
  let width = Math.max(1, Math.floor(tokens.length / 2));
  while (width >= 1) {
    let reduced = false;
    for (let start = 0; start + width <= tokens.length; start += 1) {
      const source = [...tokens.slice(0, start), ...tokens.slice(start + width)].join("").trim();
      if (source.length === 0) continue;
      const candidate = Object.freeze({ ...probe, source });
      if (await preservesFailure(candidate)) {
        tokens = candidate.source.match(/\S+\s*/gu) ?? [];
        reduced = true;
        break;
      }
    }
    if (!reduced) width = Math.floor(width / 2);
  }
  return defineConformanceProbe({ ...probe, source: tokens.join("").trim() });
}
