import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface BuildMetafile {
  readonly inputs: Readonly<Record<string, unknown>>;
}
interface BunBundler {
  build(options: {
    entrypoints: string[];
    target: "bun";
    packages: "external";
    write: false;
    metafile: true;
  }): Promise<{
    readonly success: boolean;
    readonly logs: readonly unknown[];
    readonly outputs: readonly { readonly kind: string; text(): Promise<string> }[];
    readonly metafile?: BuildMetafile | string;
  }>;
}

/** Bun compiles local config imports together so one fresh import reloads the entire local graph. */
export async function importBunConfig(
  file: string,
  onImport: (url: string) => void,
): Promise<{ readonly default?: unknown }> {
  const specifier = "bun";
  const bun = (await import(specifier)) as BunBundler;
  const result = await bun.build({
    entrypoints: [file],
    target: "bun",
    packages: "external",
    write: false,
    metafile: true,
  });
  if (!result.success) throw new AggregateError(result.logs, `Could not compile configuration ${file}`);
  if (result.metafile === undefined) throw new Error("Bun configuration loading requires Bun.build metafile support");
  const metadata =
    typeof result.metafile === "string" ? (JSON.parse(result.metafile) as BuildMetafile) : result.metafile;
  for (const input of Object.keys(metadata.inputs)) onImport(pathToFileURL(resolve(input)).href);
  const output = result.outputs.find((item) => item.kind === "entry-point");
  if (output === undefined) throw new Error(`Bun produced no configuration module for ${file}`);
  // Preserve relative asset URLs and external package lookup, without replacing the user's config.
  const temporary = join(dirname(file), `.typed-sql-config-${randomUUID()}.mjs`);
  try {
    await writeFile(temporary, await output.text(), { flag: "wx", mode: 0o600 });
    return (await import(pathToFileURL(temporary).href)) as { readonly default?: unknown };
  } finally {
    await rm(temporary, { force: true });
  }
}
