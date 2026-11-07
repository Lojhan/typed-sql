# Grammar catalog tools

This private tool workspace owns grammar-neutral acquisition and generation mechanics. Engine
facts and interpretation belong to registered mappers under `src/mappers/`; shared model and
registry modules do not select behavior by engine name.

`createMapperRegistry` accepts arbitrary grammar IDs. Contributions use a distinct ID and
`extends` to inherit a mapper's mechanics while supplying their own fact extraction. Registration
rejects duplicate IDs, missing methods, unknown parents and cycles. It does not mutate the base
registry. The built-in composition root is a list of registrations, not a closed engine dispatch.

Legacy audit/generation commands currently delegate signature extraction, version bands and
context normalization to these mappers. Original capture hashes remain unchanged; normalized
views can reconcile wire encodings without erasing archived profile differences. This is the
first migration stage; the full source pipeline, qualified projections and loading transition
are specified in the [implementation specification](../../planning/grammar-completeness/spec.md).

Contract tests run through `pnpm test:contracts` and include a synthetic external grammar and an
inherited graph contribution. Runtime packages must not import this workspace.
