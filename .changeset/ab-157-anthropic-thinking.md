---
'@lostgradient/operative': minor
---

Add an explicit extended-thinking request parameter for Anthropic.

`AnthropicProviderOptions` gains `thinking`, mirroring the native Anthropic request shape directly: `{ type: 'enabled'; budget_tokens: number } | { type: 'disabled' }`. This is a second, provider-native escape hatch alongside the existing neutral `effort` knob rather than a competing abstraction over the same dimension — `effort` continues to lower to `output_config.effort`, `thinking` lowers to the `thinking` field, and neither overrides the other. When a caller sets both, both are sent on the request body and Anthropic applies its own documented interaction between them. Only `createAnthropicProvider` and `createAnthropicProviderStream` expose the option; OpenAI and Gemini have nothing to import for this, so `getProviderCapabilities` continues to report `explicitThinkingRequest: true` only for `anthropic`.
