# @typed-sql/conformance

Versioned, feature-addressable compatibility and differential tests for first- and third-party typed-sql grammars.

Release track: **stable**.

The v2 kit joins parser, resolver, compiler, rendering, prepare, execution, and plan evidence in one
machine-readable report. Probe IDs are permanent, target selection is version/capability aware, and
skipped or quarantined layers never count toward an exact completeness claim. The package installs no
database driver; applications and E2E projects supply live adapters explicitly.

```ts
import {
  CONFORMANCE_VERSION,
  defineConformanceSuite,
  runStaticConformanceProbe,
} from "@typed-sql/conformance/v2";

const suite = defineConformanceSuite({
  version: CONFORMANCE_VERSION,
  name: "acme",
  probes: [selectProbe],
});

const result = runStaticConformanceProbe(suite.probes[0], target, {
  dialect: acme(),
  snapshot,
  renderer,
  parse,
});
```

The package-root v1 fixture helpers remain available for typed-sql 2.x consumers. Use
`runAdaptedGrammarConformanceV1()` from the v2 subpath while migrating; adapted probes expose missing
layers as skips and therefore cannot inflate exact coverage. The v1 API is removed in typed-sql 3.0.

Repository maintainers can run the static kit with `pnpm conformance:v2` and all live targets with
`pnpm conformance:live`. A failure reproduction can be rerun with the emitted `--grammar`, `--probe`,
`--database-version`, and optional `--fixture-group` filters. Live reports and reproductions contain
normalized evidence only; adapter error details and bound values are redacted.

See the [custom grammar guide](https://lojhan.github.io/typed-sql/extending/custom-grammars.html)
for the complete fixture and compatibility policy.
