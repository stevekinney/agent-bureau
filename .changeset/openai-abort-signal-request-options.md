---
'@lostgradient/operative': patch
---

`createOpenAIProvider` and `createOpenAIProviderStream` now pass the run's abort signal to the `openai` SDK as request options (`chat.completions.create(params, { signal })`) instead of as a body parameter, which the SDK ignored. `run.abort()` now closes the upstream OpenAI stream immediately, and an aborted run parked on a stalled stream resolves with `finishReason: 'aborted'` instead of hanging (AB-238, the same defect class as AB-189). The `OpenAIClient` and `OpenAIStreamingClient` interfaces gain an optional second `create` argument typed as the new `OpenAIRequestOptions`, and the OpenAI mock clients record it per call as `_requestOptions`.
