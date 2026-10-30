import remapping from "@jridgewell/remapping";
import MagicString from "magic-string";
import type { BuildSourceMap } from "./engine.js";

export function identityMap(source: string, id: string): BuildSourceMap {
  return JSON.parse(
    new MagicString(source).generateMap({ source: id, file: id, includeContent: true, hires: true }).toString(),
  ) as BuildSourceMap;
}

export function composeMaps(output: BuildSourceMap, input?: BuildSourceMap | null): BuildSourceMap {
  if (input === undefined || input === null) return output;
  return JSON.parse(JSON.stringify(remapping([output, input], () => null))) as BuildSourceMap;
}

export function inlineMap(code: string, map: BuildSourceMap): string {
  return `${code}\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n`;
}

/** Used only by hosts that require JavaScript instead of accepting TypeScript input. */
export async function javascript(
  code: string,
  id: string,
  input: BuildSourceMap,
  format?: "esm" | "cjs",
): Promise<{ code: string; map: BuildSourceMap }> {
  let esbuild: typeof import("esbuild");
  try {
    esbuild = await import("esbuild");
  } catch (cause) {
    throw new Error(
      "This integration needs the application-owned esbuild transpiler. Install it with: pnpm add -D esbuild",
      { cause },
    );
  }
  const output = await esbuild.transform(code, {
    sourcefile: id,
    loader: id.endsWith(".tsx") ? "tsx" : "ts",
    target: "esnext",
    jsx: "preserve",
    sourcemap: "external",
    sourcesContent: true,
    ...(format === undefined ? {} : { format }),
  });
  return { code: output.code, map: composeMaps(JSON.parse(output.map) as BuildSourceMap, input) };
}
