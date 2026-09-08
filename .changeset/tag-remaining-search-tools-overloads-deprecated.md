---
'armorer': patch
---

`searchTools`'s `@deprecated` tag previously sat on only the first of its six overload signatures, so only the zero-argument call resolved to a tagged signature and `@typescript-eslint/no-deprecated` warned inconsistently — one call flagged, roughly a dozen sibling calls to the exact same deprecated function silently clean. All six overload signatures (the five public overloads plus the implementation signature) now carry the identical "Use `queryTools` for tool discovery" `@deprecated` tag, so every call to `searchTools` produces the same compiler hint regardless of which overload it resolves to. This is a documentation-only change: no runtime behavior, parameter, or return type changed.
