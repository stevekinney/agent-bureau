# Session Persistence

> [!NOTE]
> **Status**: This work is shipped in the current gateway-first productization pass.

## Overview

**Session persistence**: Agent Bureau now treats sessions as the product-level persistence model. `operative` owns the durable session shape through `AgentSession` and `SessionStore`, while `gateway` exposes that model directly through `sessionId`-based APIs and session routes.

The important mental model is simple: `Conversation` still knows how to persist itself for low-level library usage, but the gateway does _not_ treat that as its source of truth anymore. The product surface runs through `SessionStore`, which keeps the runtime, HTTP layer, and UI aligned on one session model.

## Current Architecture

The current implementation centers on these files:

- `packages/operative/src/agent-session.ts`: canonical session shape plus `createAgentSession()`, `saveAgentSession()`, and `loadAgentSession()`
- `packages/operative/src/session/create-session-store.ts`: `SessionStore` factory backed by Weft's conditional text-value store
- `packages/operative/src/session/session-resume.ts`: session resume helper
- `packages/gateway/src/create-bureau.ts`: session-backed run creation, resume, listing, and deletion
- `packages/gateway/src/routes/sessions.ts`: session HTTP routes
- `packages/gateway/src/types.ts`: `CreateRunRequest.sessionId`, `Bureau.listSessions()`, `Bureau.getSession()`, and `Bureau.deleteSession()`

From the outside, the product contract is now:

- `POST /api/v1/runs` accepts `sessionId`
- `GET /api/v1/sessions` lists persisted sessions
- `GET /api/v1/sessions/:id` returns the stored `AgentSession`
- `DELETE /api/v1/sessions/:id` removes the stored session

The older conversation-route model is intentionally gone from the gateway product surface.

## Runtime Flow

**Create or resume**: When a run request includes `sessionId`, the bureau loads that session from `SessionStore`, restores the conversation history, and continues from the persisted state. When no session exists, a new session is created and becomes the canonical record for the run.

**Persist**: Session updates are written through the session store during run lifecycle handling. That keeps session summaries, timestamps, and conversation state aligned with what the gateway exposes over HTTP.

**Conflict handling**: `AgentSession` carries a persisted `revision`. The
session store writes with Weft's conditional batch primitive and retries
conflicts by merging the latest stored session with the writer's candidate
session. Conversation messages are preserved by message id, run references are
preserved by `runId`, and candidate metadata wins only for keys it writes.

**List and inspect**: The gateway never reconstructs sessions from `Conversation` storage. It reads the canonical summaries and session payloads from `SessionStore`.

**Delete**: Removing a session deletes the product-level persisted record. There is no compatibility layer for the old conversation routes or `conversationId`.

## Design Boundaries

Some choices here are deliberate:

- **No compatibility shim**: `sessionId` replaced `conversationId` in the gateway API. The branch does not keep both names alive.
- **One source of truth**: `SessionStore` is the gateway persistence boundary. `Conversation` persistence remains available to lower-level library consumers, but it is no longer the gateway contract.
- **No blind overwrites**: session writers must go through `SessionStore.save()` or `SessionStore.update()` so cross-writer changes merge instead of reverting to last-write-wins.
- **Durability is separate from sessions**: This shipped work gives you resumable sessions at run and step boundaries. Exact mid-step crash recovery still belongs to the future durable-execution work in [`durable-execution.md`](durable-execution.md).

## What This Unlocked

This session model is what made the rest of the branch coherent:

- Live UI updates can attach to runs while still resuming the same session later.
- Run detail and session detail now speak the same persistence language.
- Scheduler-triggered work can target the same session abstraction as interactive chat.
- Future automation and workbench features have a stable persistence boundary to build on.

## Remaining Gaps

This area is in good shape, but a few follow-on opportunities remain:

- Session search and richer filtering beyond the current list surface
- Cleanup policies and operator-facing retention controls
- Cross-run session analytics in the gateway UI
- Durable mid-step checkpointing rather than step-boundary persistence

## Verification

Use these commands when touching the session surface:

```bash
bun test packages/operative/
bun test packages/gateway/
bun run validate
```
