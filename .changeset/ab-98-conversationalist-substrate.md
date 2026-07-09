---
"conversationalist": minor
---

Add first-class prompt-cache checkpoint metadata and a structured prompt-assembly path, closing the last gaps in making conversationalist the runner's full conversation substrate.

- `Message`/`MessageInput` gain `cacheBoundary?: boolean` — a message-level mark that everything up to and including it is a stable, cacheable prefix. It survives JSON serialization, markdown export/import, compaction, truncation, redaction, and streaming finalize. `toAnthropicMessages` lowers it to native `cache_control: { type: 'ephemeral' }` (on the message's last content block, or as an addressable `system` block for system messages); `fromAnthropicMessages` restores it on import. OpenAI and Gemini adapters treat it as a documented no-op (both cache automatically / out-of-band, with no per-message wire field to target).
- `sectionsToMessageInputs(composer, options)` (new export from `conversationalist/composition`) renders an `InstructionComposer`'s sections into an ordered array of individually-addressable `system`-role `MessageInput`s instead of one joined string, so callers can express stable-prefix discipline (shared contract, guidelines, task context, diff, agent role, ...) natively in the conversation. `InstructionSection` gains an optional `cacheBoundary` that carries through to its rendered message. Rendering is pure and deterministic — two assemblies of the same composer and variables are byte-identical.

No parallel annotated-message wrapper layer was introduced; the mark lives directly on `Message`/`MessageInput`.
