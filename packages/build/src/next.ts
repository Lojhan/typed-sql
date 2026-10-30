import { fileURLToPath } from "node:url";
import type { LoaderOptions } from "./loader.js";
import { TypedSqlPlugin } from "./webpack.js";

interface WebpackConfiguration {
  plugins?: unknown[];
}
interface TurbopackRule {
  loaders: { loader: string; options: { [key: string]: string | number | boolean | string[] } }[];
  as: string;
  condition?: { content: RegExp };
}
interface NextConfiguration {
  turbopack?: { rules?: Record<string, TurbopackRule>; [key: string]: unknown };
  webpack?: (config: WebpackConfiguration, context: unknown) => WebpackConfiguration;
}

/** Adds both Next build backends without replacing the application's typechecking policy. */
export function withTypedSql<Config extends object = object>(
  config: Config = {} as Config,
  options: LoaderOptions = {},
): Config & { turbopack: { rules: Record<string, TurbopackRule> } } {
  const current = config as NextConfiguration;
  const loader = fileURLToPath(new URL("./webpack-loader.cjs", import.meta.url));
  const rules = { ...current.turbopack?.rules };
  const { include, exclude, ...rest } = options;
  const loaderOptions = {
    ...rest,
    ...(include === undefined ? {} : { include: [...include] }),
    ...(exclude === undefined ? {} : { exclude: [...exclude] }),
  };
  const sqlRule = { loaders: [{ loader, options: loaderOptions }], as: "*.js" };
  if (rules["*.sql"] !== undefined)
    throw new TypeError(
      "A Turbopack *.sql rule already exists; compose the typed-sql loader explicitly instead of overwriting it",
    );
  rules["*.sql"] = sqlRule;
  if (options.inline !== false) {
    for (const extension of ["ts", "tsx", "mts", "cts"]) {
      const pattern = `*.${extension}`;
      if (rules[pattern] !== undefined)
        throw new TypeError(`A Turbopack ${pattern} rule already exists; compose the typed-sql loader explicitly`);
      rules[pattern] = {
        condition: { content: /\bsql\b/u },
        loaders: [{ loader, options: loaderOptions }],
        as: `*.${extension}`,
      };
    }
  }
  const previous = current.webpack;
  return {
    ...config,
    turbopack: { ...current.turbopack, rules },
    webpack(webpackConfig: WebpackConfiguration, context: unknown) {
      const result = previous?.(webpackConfig, context) ?? webpackConfig;
      result.plugins ??= [];
      result.plugins.push(new TypedSqlPlugin(options));
      return result;
    },
  };
}
export default withTypedSql;
