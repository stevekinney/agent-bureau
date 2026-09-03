---
'@lostgradient/operative': patch
---

`withCacheMetrics` now reattaches its inner `generate`'s `BackendDescriptor`(s) (AB-64, AB-245, AB-288) onto the `generate` it returns, following the same single-inner-function reattachment pattern `withCache` already uses. Before this fix, an Agent built on `withCacheMetrics` reported an opaque generation profile even when the wrapped provider factory had attached a descriptor, because `withCacheMetrics` returned a fresh tracked closure instead of propagating `withCache`'s descriptor-stamped output.
