---
"@typed-sql/analysis": minor
---

Introduce validated, content-addressed query contracts and a synchronous frozen dialect consumer.
Contracts preserve exact query/context/codec bindings and derive application types from validated
runtime descriptors. Explicit durable exports publish immutable context/query objects through an atomic
manifest; import validates the declared closure without falling back to local caches. Missing contracts and incompatible contexts produce conservative diagnostics.

Add explicit native acquisition sessions and validated facet evidence. Native evidence preserves
unknown nullability and partial identities, binds parameter occurrences and context revisions,
and must agree with emitted runtime descriptors. Acquisition guards context, supports cancellation,
and closes its session before returning a contract.
