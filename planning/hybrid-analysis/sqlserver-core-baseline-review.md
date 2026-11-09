# SQL Server diagnosed-result baseline review

[CI run 42557443067](https://github.com/Lojhan/typed-sql/actions/runs/42557443067), source
`3f4defff369904b4637840f4d6c69f5afb398114`, passes the core/native and installed-host paths but
stops catalog qualification on reviewed-observation differences in all four SQL Server engines.
The artifacts contain no new category fingerprints or recognition-count changes.

## Exact change

One already-diagnosed invocation changes in each supported compatibility profile:

```sql
SELECT grouping_id() AS value
```

Both versions emit the same TSQ202 error, message and source span: the offline rule expects
1–32 arguments. Native result description accepts this generated invocation and reports int;
that is not proof of general execution semantics. The offline diagnostic remains in place.

Before the invalid-arity guard, the diagnostic was accompanied by an optimistic non-null number
column with database type int. The guard that prevents IIF() from reading a missing condition
now returns unknown, nullable, without a native type claim for an invalid/unqualified call.
The same conservative change occurs in compatibility analysis and core analysis. No native
metadata, ordered parameters, diagnostics, source spans, acceptance status or coverage counts
change. This review does not add GROUPING_ID() to supported offline semantics.

## Reproducible comparison

[review-conservative-observations.mjs](./review-conservative-observations.mjs) is read-only. It
loads the previous committed baselines and compares the downloaded captures. It requires:

- Only the recognition fingerprint changes; all inventory categories and counts remain equal.
- Changed observations already have an error and retain identical non-column fields.
- Replacement result columns are unknown and nullable, with no database type claim.
- Replacing only those columns with the old diagnosed-result columns reproduces the entire old
  observation fingerprint, including observations not stored as negative findings.
- Repeated default/profile captures of the same target agree.

The four transport artifacts are `sqlserver-transport-14-1` through `sqlserver-transport-17-1`
from the linked run. Unpack them and pass their catalog JSON paths:

```sh
node planning/hybrid-analysis/review-conservative-observations.mjs \
  3f4defff369904b4637840f4d6c69f5afb398114 \
  /capture/14/catalog-14.json /capture/15/catalog-15.json \
  /capture/16/catalog-16.json /capture/17/catalog-17.json
```

The comparison passes all 14 captures, representing 10 unique compatibility targets. Exactly
one invocation changes per capture. Eight negative controls separately mutate result labels/spans, native metadata, result optimism,
diagnostics, recognition counts, a successful observation and an inventory row;
every control is rejected. Only the ten reviewed recognition/finding fingerprints are accepted.
The shared finding dictionary replaces one observation; no captured vendor corpus is added.

## Native core evidence from the same run

| Exact engine | Compatibility profiles | Qualified native contracts | Unsafe relation rejections |
| --- | --- | ---: | ---: |
| 14.0.3560.2 | 140 | 7 | 4 |
| 15.0.4500.2 | 140, 150 | 14 | 8 |
| 16.0.4305.5 | 140, 150, 160 | 21 | 12 |
| 17.0.5035.5 | 140, 150, 160, 170 | 28 | 16 |

All 110 case records pass. Installed core generation, decoding, live editor and disconnected
frozen-consumer steps also pass before catalog review. The baseline edit still requires a fresh
hosted run; these observations do not turn the earlier aggregate failure into a green run.
