# Security policy

## Reporting

Do not open a public issue for a suspected vulnerability. Use the repository's private
[GitHub security advisory](https://github.com/Lojhan/typed-sql/security/advisories/new). Include the
affected package/version, a minimal reproduction, impact, and any proposed mitigation. Maintainers
will acknowledge a report within seven days and coordinate disclosure after a fix is available.

Security fixes target supported stable releases. Experimental packages receive fixes when practical
but do not carry a long-term support promise.

## Threat model and trust boundary

typed-sql analyzes application source and database catalog snapshots during development. SQL text,
snapshots, config modules, migration files, TypeScript projects, and database responses are treated
as untrusted input. Database credentials and executable config files remain application-controlled.

- The tokenizer caps a query at 1,000,000 characters and 100,000 tokens.
- The parser caps recursive nesting at 128 levels. Limit violations produce `TSQ002`.
- Editor caches and workspace scans are bounded, and long-running requests support cancellation.
- Generated files contain catalog metadata and type policy, never connection strings.
- Interpolated query values become driver parameters. `sql.raw()` is deliberately unsafe and must
  receive trusted static SQL; it is not an escaping API.
- Identifiers must use `sql.ident()`, which delegates quoting to the selected dialect renderer.
- Grammar packages do not install database drivers. Driver adapters load an application-owned
  driver only when their explicit `/pg` or `/mysql2` subpath is invoked.

Config files are executable TypeScript and therefore have the same authority as other application
build scripts. Do not run typed-sql against an untrusted repository outside an appropriate sandbox.
Live introspection should use a least-privilege, read-only database account where possible.

## Repository and release controls

- `main` accepts changes only through pull requests with an up-to-date branch, resolved
  conversations, signed commits, linear history, and all required CI checks. Administrators are
  subject to the same rules.
- GitHub Actions run with read-only permissions by default. External actions are allowlisted,
  required to use full commit SHAs, and maintained through Dependabot.
- Dependency Review blocks pull requests that add high-severity vulnerable dependencies. CodeQL,
  Dependabot security updates, secret scanning, and push protection are enabled.
- npm publication uses the protected `npm` environment and trusted publishing through OIDC. Package
  publishing requires 2FA and rejects traditional automation tokens.
- Published `@typed-sql/*` GitHub tags cannot be deleted or moved.
