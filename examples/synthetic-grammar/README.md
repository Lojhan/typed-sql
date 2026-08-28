# Synthetic third-party grammar

This deliberately small grammar demonstrates the complete public `@typed-sql/conformance` fixture.
It imports only published package entrypoints, declares unsupported capabilities explicitly, and
uses conservative semantic metadata where its toy analyzer cannot prove more.

Run it from the repository with:

```sh
pnpm --filter @typed-sql/example-synthetic-grammar test
```
