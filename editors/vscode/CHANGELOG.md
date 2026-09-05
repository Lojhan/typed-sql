# typed-sql

## Unreleased

- Serialize client startup, configuration restarts and shutdown to avoid overlapping workspace servers.

- Verify real SQL overlays, inferred completions, TypeScript diagnostics and unsaved edits through an isolated packaged VS Code host.

- Declare the workspace trust requirement and unsupported virtual-workspace boundary explicitly.
- Verify the packaged VSIX in isolated trusted, Restricted Mode and virtual-workspace hosts.

## 1.0.0

### Major Changes

- Publish the stable VS Code extension with TypeScript 7 query hovers, diagnostics, completion,
  definitions, safe quick fixes, cancellation, and bounded project caches.

### Dependency Changes

- Updated dependencies
  - @typed-sql/core@1.0.0
  - @typed-sql/config@1.0.0
  - @typed-sql/schema@1.0.0
  - @typed-sql/ts-bridge@1.0.0
