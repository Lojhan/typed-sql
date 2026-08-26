# Release-candidate soak

typed-sql does not promote an RC to npm `latest` from repository CI alone. The exact candidate must
spend 7–14 full days in at least three independent, registry-only consumer repositories. The
PostgreSQL, MySQL, and editor roles must all be represented.

The stable Release workflow runs `pnpm release:soak` before any registry write. That command reads
`release/rc-soak.json`, validates the evidence, and verifies that its candidate is the same RC from
which the stable version was rehearsed. A missing report, a report written too early, or evidence
for an older RC blocks publication.

## Start a soak

1. Publish one coherent `1.0.0-rc.N` train under npm `next`.
2. Verify the post-publication registry-only PostgreSQL and MySQL suite is green.
3. Copy `release/rc-soak.example.json` to `release/rc-soak.json`.
4. Replace every example value with the published RC's real version, commit, publication time, and
   consumer data.
5. Install exact npm versions in three repositories. Do not use `workspace:`, `file:`, `link:`, pnpm
   overrides, or paths into this checkout.
6. Run every consumer during the first 24 hours and again after the complete minimum period.

`startedAt` cannot precede `publishedAt`. If a release-blocking fix changes inference, generated
output, runtime contracts, exports, or release mechanics, publish a new RC and start a new report
and clock. Never carry elapsed time or test evidence from an older candidate.

## Required consumers

The report records exact Node, pnpm, TypeScript, database, driver, editor, and typed-sql versions.
Each run links to immutable HTTPS evidence and the exact consumer commit.

- `postgres`: clean install, generation, TypeScript checks, runtime execution, schema drift,
  deterministic generation, `pg` compatibility, and conditional query composition.
- `mysql`: the equivalent checks against MySQL and `mysql2`.
- `editor`: installation, generation, TypeScript checks, hover types, diagnostics, quick fixes, and
  a full editor/language-server restart.

PostgreSQL and MySQL runs record the SHA-256 digest of generated output. Every run for one consumer
must produce the same digest. Repositories and consumer ids must be distinct; fixtures inside this
monorepo do not count as external consumers.

## Blockers and decision

Record every discovered blocker in the report. Supported categories cover inference, false
rejection, false acceptance, nondeterminism, drivers, installation, editor behavior, documentation,
and security. A blocker must be resolved and link to its regression test; otherwise the stable gate
fails.

After the complete period, record a reviewed `go` decision, its owner, rationale, and known
limitations. Then validate locally:

```sh
pnpm release:soak
```

The command is intentionally expected to fail until the entire clock and evidence contract are
satisfied. The report is release evidence, not a checklist to pre-fill.
