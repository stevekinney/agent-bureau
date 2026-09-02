---
'@lostgradient/operative': patch
---

Pass the run's abort signal to the Anthropic SDK as request options instead of a body field, so `run.abort()` cancels the upstream HTTP stream and a streaming run blocked on its next chunk resolves with `finishReason: 'aborted'`. Adds the `AnthropicRequestOptions` type; `AnthropicClient` and `AnthropicStreamingClient` implementations now receive it as the second argument of `messages.create`.
