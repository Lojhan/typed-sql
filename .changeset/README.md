# Changesets

Run `pnpm changeset` for every user-visible change to a public package. The active channel is
declared by `release-manifest.json`; prereleases use npm `next`. The release workflow validates the
manifest, package tracks, exact versions, packed consumers, security policy, and registry state
before publication. Exit prerelease mode only when preparing the matching stable train.
