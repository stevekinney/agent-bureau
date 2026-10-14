---
'@lostgradient/operative': minor
---

Price and describe every current Claude model, and refuse Anthropic request shapes the API documents as a 400 before sending them.

- `defaultPricingTable` prices every current first-party Claude model at Anthropic's list prices: Fable 5.1, Mythos 5.1, Fable 5, Mythos 5, Opus 5.5, Opus 5, Opus 4.8, 4.7, 4.6 and 4.5, Sonnet 5.5, Sonnet 5, Sonnet 4.6, Haiku 5.5 and Haiku 4.5. Cache reads follow each model's published rate (0.025x input on Fable 5.1 and Mythos 5.1, 0.05x on Opus 5.5 and Sonnet 5.5, 0.1x elsewhere). Previously `createCostBudgetMonitor` threw `No pricing found` on the first step of any budgeted run on these models, and `RunResult.costEstimate` was always absent.
- Claude Haiku 5.5 carries a long-prompt tier: a request over 100,000 input tokens is priced at $0.50 / $2.50 per million tokens. `ModelPricing` gains an optional `longContext` (`LongContextPricing`), and `estimateCost` accepts a `CostEstimationScope` (`'request'`, the default, applies the tier; `'aggregate'` prices at the base tier).
- A run's terminal `costEstimate` is now the sum of each request's own estimate, accumulated where usage is folded and carried through durable checkpoints, so long-prompt tiers apply. A run resumed from an older checkpoint seeds the accumulator from its prior usage.
- The model catalog adds rows for Fable 5.1, Mythos 5.1, Opus 5.5, Opus 5, Sonnet 5.5 and Haiku 5.5, with documented effort support. Descriptor `pricing` gains an optional `longContext`, and selection ranks a tiered model by its long-context rates. Mythos 5 and 5.1 report `availability: 'unknown'`, since they require Anthropic's verification program.
- Catalog rows advertise `temperature` and `topP` only for models that accept them, and Opus 4.5's effort support is corrected to `low` through `high`.
- Re-export `createManualRuntimeServices`, `CreateManualRuntimeServicesOptions` and `ManualRuntimeServices` from the package root, and resolve retry jitter's default random source once instead of on every call.
- Require `@lostgradient/weft` `^0.27.17`.

Upgrade notes:

- The Anthropic provider factories now throw a `ProviderError` at construction, before any request, for combinations Anthropic documents as a 400: non-default `temperature`/`topP` (or both together) on Opus 4.7 and later, Sonnet 5 and later, Haiku 5.5, Fable and Mythos; manual `thinking: { type: 'enabled' }` on Claude 4.7 and later; `thinking: { type: 'disabled' }` on Opus 5.5, Sonnet 5.5, Fable and Mythos, and on Opus 5 and Haiku 5.5 at `xhigh` or `max` effort; and forced tool choice (`required` or a named tool) on Opus 5.5, Sonnet 5.5, Fable 5.1 and Mythos 5.1. These requests previously failed at the API instead.
- `selection` lowest-cost ranking now treats Claude Haiku 5.5 at its long-context rates.
