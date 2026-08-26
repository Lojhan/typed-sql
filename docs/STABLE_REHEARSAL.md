# Stable release rehearsal

Run the complete prerelease-to-stable transition without writing to npm or creating a public Git
tag or GitHub release:

```sh
TYPED_SQL_CONTAINER_ENGINE=podman pnpm release:rehearse
```

The command requires a clean tracked checkout, Node.js 22.11 or newer, pnpm 10.32.1, and Docker or
Podman. It creates a detached temporary worktree at the current commit and performs the transition
there. The caller's checkout is never versioned.

The rehearsal:

- requires one coherent RC train and exits Changesets `rc` prerelease mode;
- separates mixed Changesets by the stable and experimental package policies;
- versions the stable train to exactly `1.0.0`, changes the release manifest to `stable:latest`,
  and records the originating RC as `sourceCandidate`;
- restores experimental package versions, changelogs, and pending Changesets so preview-backed
  work is not accidentally promoted or discarded;
- refreshes the lockfile and runs `release:assert stable`;
- runs the complete verification suite and packed PostgreSQL/MySQL acceptance;
- packs every stable package in manifest publication order;
- rejects unresolved `workspace:` ranges and installs the tarballs together in a clean consumer;
- proves that the stable package graph installs no database driver implicitly;
- writes a deterministic version diff, report, and inspected tarballs under
  `artifacts/stable-rehearsal/`.

Review these local, ignored artifacts:

```text
artifacts/stable-rehearsal/
├── report.json
├── stable-release.diff
└── packages/
```

`report.json` records the mixed package versions, stable publication order, packed internal
dependency ranges, and zero registry writes or public tags. `stable-release.diff` is the proposed
version-PR change; it is never applied to the caller's checkout automatically.

## Retry and recovery

Beta, RC, and stable publication use the same fail-closed publisher. Before each package write it
asks npm whether that exact name and version already exists. A retry skips published versions,
continues in manifest order, and creates Changesets tags only after every package is present.

Poku tests simulate an ambiguous failure after every package boundary and a failure during tag
creation. Each retry must avoid republishing immutable npm versions. Registry lookup failures are
fatal: the publisher never guesses that a version is missing.

## Write boundary

The rehearsal process has no npm-publish, git-tag, git-push, or GitHub-release operation. Its child
processes are limited to detached-worktree management, Changesets versioning, lockfile refresh,
verification, packing, tarball inspection, and isolated installation. The real stable write remains
exclusive to the protected Release workflow on `main`, using the approval-gated `npm` environment
and GitHub OIDC trusted publishing.
