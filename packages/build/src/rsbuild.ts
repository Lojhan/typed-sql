import type { LoaderOptions } from "./loader.js";
import { TypedSqlPlugin } from "./webpack.js";

export function typedSql(options: LoaderOptions = {}) {
  return {
    name: "typed-sql",
    setup(api: { modifyRspackConfig(callback: (config: { plugins?: unknown[] }) => void): void }) {
      api.modifyRspackConfig((config) => {
        config.plugins ??= [];
        config.plugins.unshift(new TypedSqlPlugin(options));
      });
    },
  };
}
export default typedSql;
