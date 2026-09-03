---
'@lostgradient/operative': patch
---

Fixes `withEnhancedStreaming`, `withCache`, the provider instrumentation wrapper (`instrument`), `createFallbackGenerate`, and `createFalloverGenerate` to preserve the `BackendDescriptor`(s) attached to the generate function(s) they wrap (AB-64, AB-245, AB-288). Previously these five wrappers returned a new function with no attachment, so an Agent whose `generate` was wrapped by any of them reported an opaque generation profile even though its inner backend was described. `createFallbackGenerate` and `createFalloverGenerate` attach the ordered union of every candidate's descriptors, deduplicated by `(provider, endpoint, model)`, matching `createRoutingGenerate`'s existing union behavior.
