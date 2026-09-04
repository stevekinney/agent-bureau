---
'@lostgradient/operative': patch
---

Forward the run's resolved `RuntimeServices` (AB-92/AB-252) into every `Conversation` operative constructs (AB-321), not only into `RunOptions`. `createAgent`, `createRun`'s in-memory and durable paths, the durable adapter's checkpoint-reconstruction fallbacks, `startDurableRunResult`/`resumeDurableRunResult`, the scheduler's in-memory and durable dispatch, session resume/fork, and the schema-error/overflow/temperature-escalation retry mutators now all pass `{ runtime }` (or the source conversation's own `.env`) when building a fresh `Conversation`, instead of letting it fall back to `conversationalist`'s real-globals default independently of the rest of the run.

Fixes a real reproduction gap: two runs driven by identically-seeded manual runtimes previously still produced a different `conversation.id` in their terminal `RunResult`, because conversationalist's id/timestamp seam was never wired to the run's own runtime. `run.result().conversation`'s id and timestamps are now byte-identical across two such runs, closing the last piece of AB-92's reproduction guarantee (AB-263's reproduction-artifact assembler documented this exact gap as a follow-up).

Not forwarded: `createLazyAgent`'s pre-load synthetic fallback conversation (no `RuntimeServices` reaches that deferred wrapper — its `AgentRunContext`/`CreateLazyAgentOptions` carry no runtime field) and the scheduler's internal chunked-task placeholder conversation (`scheduler/create-chunked-task.ts`, never read by `generate` and constructed before the scheduler resolves its own runtime). Both are documented, deliberate exclusions, not oversights.
