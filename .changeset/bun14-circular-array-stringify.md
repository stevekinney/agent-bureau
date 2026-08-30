---
'@lostgradient/operative': patch
'conversationalist': patch
'armorer': patch
---

Stop tool-result materialization from throwing on a self-referential array. `interoperability`'s non-JSON fallback called `String()` directly, which relies on `Array.prototype.join`'s cycle guard — an engine extension rather than a spec requirement. On Bun 1.3.13 that yields `'1,2,'`; on Bun 1.4.0 it recurses until the stack overflows and a `RangeError` escapes what is supposed to be a total normalization step. Cycles are now elided before coercion, so every supported runtime produces the documented result. Circular plain objects still render as `[object Object]`, unchanged. This ships to consumers because `interoperability` is inlined into these packages at build time.
