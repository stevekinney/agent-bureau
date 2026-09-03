---
'@lostgradient/operative': minor
---

Narrowed the overlap policy Agent Bureau exposes on its schedule-creation surfaces, and added a typed error for a schedule-locator failure (AB-191, implementing AB-41's ratified decision record).

- `CreateAgentScheduleOptions.overlap` and `AgentScheduleOptions.overlap` are now typed `AgentScheduleOverlapPolicy` (`'skip' | 'allow'`), a new exported type, instead of Weft's full `ScheduleOverlapPolicy` (`'skip' | 'queue' | 'cancel-running' | 'allow'`). `createAgentSchedule`/`AgentScheduler.schedule` also reject `'queue'`/`'cancel-running'` at runtime with a typed `InvalidScheduleError`, before any Weft-side `engine.schedule()` call — so a caller that coerces an untyped value past the compiler (deserialized JSON, an `as` cast) is still rejected, not silently forwarded.
- The `scheduleSelf` tool's Zod input schema now accepts only `z.enum(['skip', 'allow'])` for `overlap`; a `'queue'`/`'cancel-running'` request now fails Zod validation at the tool boundary instead of reaching Weft.

`'queue'` and `'cancel-running'` were never reliably usable through these three creation paths — `Bureau.createSchedule`'s own typed surface already narrowed to `'skip' | 'allow'` before this release — and AB-41's decision record names the omission intentional, not a gap. A caller currently passing `'queue'`/`'cancel-running'` to `createAgentSchedule`/`AgentScheduler.schedule`/`scheduleSelf` will now get a rejection instead of (previously inconsistent) forwarding.

**Migration:** a caller relying on `'queue'`/`'cancel-running'` reaching Weft through `createAgentSchedule`, `AgentScheduler.schedule`, or the `scheduleSelf` tool must drop to `'skip'` or `'allow'`, or call the Weft engine's own scheduling API directly — Agent Bureau does not expose those two policies on any surface.
