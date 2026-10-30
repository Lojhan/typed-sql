import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BuildSession, type BuildSourceMap } from "./engine.js";
import { composeMaps, identityMap, javascript } from "./maps.js";
import type { BuildOptions } from "./project.js";
import SynchronousSession from "./sync.cjs";

export interface JestOptions extends BuildOptions {
  /** Existing Babel/SWC/other Jest transformer. Its mocking and instrumentation behavior is retained. */
  readonly transformer?: { readonly module: string; readonly options?: Readonly<Record<string, unknown>> };
}

export interface JestCallerOptions {
  readonly supportsStaticESM: boolean;
  readonly configString: string;
  readonly config: { readonly rootDir: string };
  readonly instrument: boolean;
  readonly transformerConfig?: unknown;
}

interface JestOutput {
  readonly code: string;
  readonly map?: BuildSourceMap | string | null;
}
export interface JestTransformer {
  readonly canInstrument?: boolean;
  process(source: string, file: string, options: JestCallerOptions): JestOutput;
  processAsync(source: string, file: string, options: JestCallerOptions): Promise<JestOutput>;
  getCacheKey(source: string, file: string, options: JestCallerOptions): string;
  getCacheKeyAsync(source: string, file: string, options: JestCallerOptions): Promise<string>;
}
interface Delegate {
  canInstrument?: boolean;
  process?: JestTransformer["process"];
  processAsync?: JestTransformer["processAsync"];
  getCacheKey?: JestTransformer["getCacheKey"];
  getCacheKeyAsync?: JestTransformer["getCacheKeyAsync"];
}

function buildOptions(options: JestOptions, root: string): BuildOptions {
  return {
    cwd: resolve(options.cwd ?? root),
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.inline === undefined ? {} : { inline: options.inline }),
    ...(options.include === undefined ? {} : { include: options.include }),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.cacheSize === undefined ? {} : { cacheSize: options.cacheSize }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

function mapped(output: JestOutput, input: BuildSourceMap): JestOutput {
  if (output.map === undefined || output.map === null) return output;
  const map = typeof output.map === "string" ? (JSON.parse(output.map) as BuildSourceMap) : output.map;
  return { code: output.code, map: composeMaps(map, input) };
}

/** Jest awaits this factory; all later synchronous calls still run through the owned worker. */
export async function createTransformer(options: JestOptions = {}): Promise<JestTransformer> {
  const sessions = new Map<string, { async: BuildSession; sync?: SynchronousSession }>();
  let delegate: Delegate | undefined;
  if (options.transformer !== undefined) {
    const require = createRequire(resolve(options.cwd ?? process.cwd(), "package.json"));
    const imported = (await import(pathToFileURL(require.resolve(options.transformer.module)).href)) as {
      default?: Delegate;
      createTransformer?: (options?: unknown) => Delegate | Promise<Delegate>;
    };
    const factory = imported.default ?? imported;
    delegate =
      "createTransformer" in factory && typeof factory.createTransformer === "function"
        ? await factory.createTransformer(options.transformer.options)
        : (factory as Delegate);
  }
  const session = (caller: JestCallerOptions, sync = false) => {
    const root = resolve(options.cwd ?? caller.config.rootDir);
    let current = sessions.get(root);
    if (current === undefined) {
      if (sessions.size >= 8) {
        const first = sessions.entries().next().value!;
        first[1].sync?.close();
        sessions.delete(first[0]);
      }
      current = { async: new BuildSession(buildOptions(options, root)) };
      sessions.set(root, current);
    }
    if (sync) current.sync ??= new SynchronousSession(buildOptions(options, root));
    return current;
  };
  const callerOptions = (caller: JestCallerOptions) => ({
    ...caller,
    transformerConfig: options.transformer?.options ?? {},
  });
  let javascriptVersion: string | undefined;
  const transpilerKey = (file: string) => {
    if (delegate !== undefined && !file.endsWith(".sql")) return "";
    if (javascriptVersion === undefined) {
      try {
        javascriptVersion = (createRequire(import.meta.url)("esbuild") as typeof import("esbuild")).version;
      } catch (cause) {
        throw new Error(
          "This integration needs the application-owned esbuild transpiler. Install it with: pnpm add -D esbuild",
          { cause },
        );
      }
    }
    return javascriptVersion;
  };
  const key = (source: string, file: string, caller: JestCallerOptions, identity: string, delegateKey: string) =>
    createHash("sha256")
      .update(identity)
      .update("\0")
      .update(source)
      .update("\0")
      .update(file)
      .update("\0")
      .update(caller.configString)
      .update(
        JSON.stringify({
          esm: caller.supportsStaticESM,
          instrument: caller.instrument,
          transformer: options.transformer,
        }),
      )
      .update(delegateKey)
      .update("\0")
      .update(transpilerKey(file))
      .digest("hex");
  return {
    ...(delegate?.canInstrument === undefined ? {} : { canInstrument: delegate.canInstrument }),
    getCacheKey(source, file, caller) {
      return key(
        source,
        file,
        caller,
        session(caller, true).sync!.request("identity").key,
        file.endsWith(".sql") ? "" : (delegate?.getCacheKey?.(source, file, callerOptions(caller)) ?? ""),
      );
    },
    async getCacheKeyAsync(source, file, caller) {
      const delegateKey = file.endsWith(".sql")
        ? ""
        : ((await (delegate?.getCacheKeyAsync !== undefined
            ? delegate.getCacheKeyAsync(source, file, callerOptions(caller))
            : delegate?.getCacheKey?.(source, file, callerOptions(caller)))) ?? "");
      return key(source, file, caller, (await session(caller).async.identity()).key, delegateKey);
    },
    process(source, file, caller) {
      const current = session(caller, true).sync!;
      if (delegate !== undefined && !file.endsWith(".sql")) {
        if (delegate.process === undefined)
          throw new TypeError(
            "The delegated Jest transformer needs a synchronous process method for require() callers",
          );
        const result = current.request("transform", source, file);
        return mapped(
          delegate.process(result?.code ?? source, file, callerOptions(caller)),
          result?.map ?? identityMap(source, file),
        );
      }
      return current.request("javascript", source, file, caller.supportsStaticESM ? "esm" : "cjs");
    },
    async processAsync(source, file, caller) {
      const result = await session(caller).async.transform(source, file);
      const map = result?.map ?? identityMap(source, file);
      if (delegate !== undefined && !file.endsWith(".sql")) {
        if (delegate.processAsync === undefined && delegate.process === undefined)
          throw new TypeError("The delegated Jest transformer has no process method");
        return mapped(
          await (delegate.processAsync !== undefined
            ? delegate.processAsync(result?.code ?? source, file, callerOptions(caller))
            : delegate.process!(result?.code ?? source, file, callerOptions(caller))),
          map,
        );
      }
      return javascript(result?.code ?? source, file, map, caller.supportsStaticESM ? "esm" : "cjs");
    },
  };
}
