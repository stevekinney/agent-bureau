---
armorer: minor
---

Add `AnyToolbox`, an erased supertype for `Toolbox<TTools>`. `Toolbox` is invariant in its tool-tuple parameter `TTools` (the tuple appears in both input and output positions — the typed `execute` overloads, `extend`, `tools`, `getAvailable`, `getTool`), so a concretely-typed `Toolbox<ConcreteTools>` (what `createToolbox([...])` returns) was never assignable to the bare `Toolbox` default without a cast. `AnyToolbox` fixes that: every `Toolbox<TTools>`, for any `TTools`, structurally satisfies it with no cast and no `any`. Use `AnyToolbox` wherever a toolbox is accepted or stored but only ever executed generically — its tool tuple is never inspected for compile-time call/result typing.
