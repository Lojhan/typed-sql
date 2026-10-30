import type { JestOptions } from "./jest-transformer.js";

export = {
  async createTransformer(options?: JestOptions) {
    return (await import("./jest-transformer.js")).createTransformer(options);
  },
};
