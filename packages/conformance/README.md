# @typed-sql/conformance

Executable compatibility tests for first- and third-party typed-sql grammar packages.

Release track: **stable**.

The kit verifies the public dialect contract, required inference families, explicit capability
claims, fail-closed diagnostics, semantic evidence, structural variants, codecs, and reproducible
analysis performance. It imports only grammar-neutral public packages and does not install Poku or
a database driver.

```ts
import {
  assertGrammarConformance,
  defineGrammarConformanceFixture,
  GRAMMAR_CONFORMANCE_VERSION,
} from "@typed-sql/conformance";
import { describe, it } from "poku";
import { acme, acmeFixture } from "./grammar.js";

await describe("acme grammar", async () => {
  await it("passes the typed-sql contract", () => {
    assertGrammarConformance(defineGrammarConformanceFixture({
      version: GRAMMAR_CONFORMANCE_VERSION,
      dialect: acme(),
      ...acmeFixture,
    }));
  });
});
```

See the [custom grammar guide](https://lojhan.github.io/typed-sql/extending/custom-grammars.html)
for the complete fixture and compatibility policy.
