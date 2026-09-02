---
'conversationalist': minor
'@lostgradient/operative': minor
---

Adds AB-70's ratified portable-content and modality vocabulary — `Modality`, `MimeFamily`, `MediaLimitScope`, `MediaLimits`, `ContentSource`, and `ModalityMatrix` — to `conversationalist`'s `multi-modal` module and root export surface. These six names are additive and type-only; nothing already exported from `multi-modal.ts` is renamed, reshaped, or removed.

`@lostgradient/operative` gains AB-64's ratified `BackendDescriptor`/`ModelCatalog` surface (`packages/operative/src/providers/model-catalog.ts`, exported from `./providers` and re-exported from `./providers/index.ts`): `BackendLifecycleState`, `ModelAlias`, `EffortSupport`, `GeneratedAssetBehavior`, `BackendDescriptor`, `ModelCatalog`, `CatalogProjection`, and the synchronous, side-effect-free `createModelCatalog()` factory. The seed catalog covers every model already named by the shipped provider tables (`ANTHROPIC_EFFORT_SUPPORT`, the three `*_MODEL_ALIASES` tables, `OPENAI_REASONING_MODELS`, `GEMINI_THINKING_MODELS`, and `defaultPricingTable`), computed rather than hand-copied.

`getProviderCapabilities` is now implemented as a projection over `createModelCatalog`, with an unchanged public signature and bit-for-bit identical answers for every `(provider, baseURL, OPENAI_BASE_URL)` combination it previously reported on — this closes out the three surfaces AB-64's decision record named as provisional.
