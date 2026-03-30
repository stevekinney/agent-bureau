# Session Persistence

## Overview

The operative package already has `AgentSession`, `saveAgentSession()`, `loadAgentSession()`, and `DefineAgentOptions` with `persistence`, `sessionId`, `onSessionSave`, `onSessionLoad`, and `autoSave` fields. The storage package just landed with `KeyValueStore` and platform adapters. These two systems exist but aren't _wired together_—there's no session lifecycle management, no session listing/search, no cleanup, and no integration with the gateway's conversation management.

This work connects operative's session system to storage adapters, adds session lifecycle management, and integrates with the gateway's existing conversation routes.

## What Exists Today

Read these files to understand the current state:

- `packages/operative/src/agent-session.ts` — `AgentSession`, `createAgentSession()`, `saveAgentSession()`, `loadAgentSession()`
- `packages/operative/src/types.ts` — `DefineAgentOptions` (persistence, sessionId, autoSave fields)
- `packages/storage/src/types.ts` — `KeyValueStore` interface
- `packages/storage/src/namespace.ts` — `withNamespace()`
- `packages/gateway/src/types.ts` — `Bureau`, `CreateRunRequest` (has `conversationId`)
- `packages/gateway/src/routes/conversations.ts` — existing conversation routes
- `packages/gateway/src/storage.ts` — gateway storage helpers
- `packages/conversationalist/src/index.ts` — `ConversationHistory`, `SessionInfo`

## Product Requirements

### PR-1: Session Store Factory

Create a `createSessionStore()` factory that wraps a `KeyValueStore` with session-specific operations:

```typescript
interface SessionStore {
  save(session: AgentSession): Promise<void>;
  load(id: string): Promise<AgentSession | undefined>;
  delete(id: string): Promise<void>;
  list(options?: SessionListOptions): Promise<SessionSummary[]>;
  exists(id: string): Promise<boolean>;
  updateMetadata(id: string, metadata: Record<string, JSONValue>): Promise<void>;
  cleanup(options: SessionCleanupOptions): Promise<number>;
}

interface SessionListOptions {
  agentName?: string;
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

interface SessionSummary {
  id: string;
  agentName: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, JSONValue>;
}

interface SessionCleanupOptions {
  olderThan: number; // ms
  agentName?: string;
}
```

All keys are namespaced under `agent-session:` prefix (matching existing `saveAgentSession` behavior).

### PR-2: Session Lifecycle Hooks

Add session lifecycle events to the operative's hook system:

- `onSessionCreate` — fired when a new session is created
- `onSessionSave` — fired after a session is persisted (replaces existing callback)
- `onSessionLoad` — fired after a session is loaded from storage (replaces existing callback)
- `onSessionDelete` — fired when a session is deleted

These extend `OperativeHookMap`.

### PR-3: Auto-Save Integration

The `autoSave` field on `DefineAgentOptions` currently accepts `'step' | 'completion' | false`. Wire this into the loop:

- `'step'`: Save session after every completed step (tool execution + result)
- `'completion'`: Save session when the run finishes (regardless of finish reason)
- `false`: Never auto-save

Auto-save uses the `SessionStore` if a `persistence` `KeyValueStore` is provided, falling back to direct `saveAgentSession()`.

### PR-4: Session Resume

When `sessionId` is provided to `defineAgent().run()` or `createRun()`, the system should:

1. Attempt to load the session from the `SessionStore`
2. If found, restore the `ConversationHistory` from the session
3. If not found, create a new session with that ID
4. Merge any new `AgentRunOptions` (hooks, stop conditions) with the restored session

This enables "pick up where you left off" workflows.

### PR-5: Gateway Integration

Update the gateway's conversation management to use `SessionStore`:

- `GET /conversations` — list sessions via `SessionStore.list()`
- `GET /conversations/:id` — load session and return conversation history
- `DELETE /conversations/:id` — delete session via `SessionStore.delete()`
- `POST /runs` with `conversationId` — resume a session by loading it and continuing the conversation

The gateway already has these routes. The work is wiring them to `SessionStore` instead of the current in-memory approach.

### PR-6: Session Cleanup

Provide a cleanup utility that can be run on a schedule (via operative's scheduler) or on-demand:

- Delete sessions older than a configurable threshold
- Delete sessions by agent name
- Return count of deleted sessions

## Architecture

### New Files

In `packages/operative/src/session/`:

- `types.ts` — `SessionStore`, `SessionListOptions`, `SessionSummary`, `SessionCleanupOptions`
- `create-session-store.ts` — `createSessionStore()` factory
- `session-resume.ts` — `resumeSession()` helper
- `index.ts` — re-exports

### Extended Files

- `packages/operative/src/hooks.ts` — add session hooks to `OperativeHookMap`
- `packages/operative/src/loop.ts` — integrate auto-save into step/completion handlers
- `packages/operative/src/agent-session.ts` — update to use `SessionStore` when available
- `packages/operative/src/index.ts` — re-export session modules
- `packages/gateway/src/create-bureau.ts` — initialize `SessionStore` from config
- `packages/gateway/src/routes/conversations.ts` — wire to `SessionStore`
- `packages/gateway/src/types.ts` — add `SessionStore` to `Bureau`

## Implementation Order (TDD)

### Phase 1: Session Store

1. Write tests for `createSessionStore()`:
   - `save()` persists session, retrievable via `load()`
   - `load()` returns `undefined` for nonexistent session
   - `delete()` removes session, subsequent `load()` returns `undefined`
   - `exists()` returns `true` for saved session, `false` for absent
   - `list()` returns all sessions sorted by `updatedAt` descending
   - `list()` filters by `agentName`
   - `list()` respects `limit` and `offset`
   - `list()` sorts by `createdAt` or `updatedAt` in either direction
   - `updateMetadata()` merges metadata without overwriting conversation
   - `cleanup()` deletes sessions older than threshold
   - `cleanup()` filters by agent name
   - `cleanup()` returns count of deleted sessions
   - All operations use `agent-session:` key prefix
   - Works with `createMemoryKeyValueStore()` from storage package
2. Implement `create-session-store.ts`
3. Verify: `bun test packages/operative/src/session/create-session-store.test.ts`

### Phase 2: Session Resume

1. Write tests for `resumeSession()`:
   - Loads existing session and returns restored conversation
   - Creates new session when ID not found
   - Merges provided hooks with restored session
   - Preserves existing conversation history on resume
   - Handles corrupted session data gracefully (creates new)
2. Implement `session-resume.ts`
3. Verify: `bun test packages/operative/src/session/session-resume.test.ts`

### Phase 3: Session Lifecycle Hooks

1. Write tests for new hooks:
   - `onSessionCreate` fires when session is first created
   - `onSessionSave` fires after persistence
   - `onSessionLoad` fires after loading from storage
   - `onSessionDelete` fires after deletion
   - Hooks receive the session object
2. Extend `OperativeHookMap` in `hooks.ts`
3. Verify: `bun test packages/operative/src/session/`

### Phase 4: Auto-Save Integration

1. Write tests:
   - `autoSave: 'step'` saves after each step completion
   - `autoSave: 'completion'` saves only when run finishes
   - `autoSave: false` never saves
   - Auto-save uses `SessionStore.save()` when available
   - Auto-save errors don't crash the run (logged, not thrown)
   - Session `updatedAt` changes on each save
2. Integrate into `loop.ts`
3. Verify: `bun test packages/operative/`

### Phase 5: Gateway Integration

1. Write tests:
   - `GET /conversations` returns session summaries from `SessionStore`
   - `GET /conversations/:id` returns full conversation history
   - `DELETE /conversations/:id` deletes session
   - `POST /runs` with `conversationId` resumes existing session
   - `POST /runs` without `conversationId` creates new session
   - Missing session returns 404
2. Update gateway routes
3. Verify: `bun test packages/gateway/`

### Phase 6: Full Integration

1. Run full operative suite: `turbo run test --filter=operative`
2. Run gateway suite: `turbo run test --filter=gateway`
3. Run full pipeline: `turbo run validate`

## Acceptance Criteria

- [ ] `createSessionStore()` exported from `operative`
- [ ] `SessionStore.save()` persists sessions to `KeyValueStore`
- [ ] `SessionStore.load()` retrieves sessions by ID
- [ ] `SessionStore.list()` returns sorted, filterable session summaries
- [ ] `SessionStore.cleanup()` deletes old sessions and returns count
- [ ] `SessionStore.exists()` checks session existence without loading full data
- [ ] `SessionStore.updateMetadata()` updates metadata without overwriting conversation
- [ ] Session resume loads existing conversation and continues from last state
- [ ] Session resume creates new session when ID not found
- [ ] `autoSave: 'step'` persists after every step
- [ ] `autoSave: 'completion'` persists when run finishes
- [ ] Auto-save errors are caught and do not crash the run
- [ ] `OperativeHookMap` includes `onSessionCreate`, `onSessionSave`, `onSessionLoad`, `onSessionDelete`
- [ ] Gateway `GET /conversations` returns data from `SessionStore`
- [ ] Gateway `POST /runs` with `conversationId` resumes session
- [ ] Backward compatible: existing `saveAgentSession`/`loadAgentSession` still work
- [ ] 100% test coverage: `bun test --coverage packages/operative/src/session/`
- [ ] `turbo run validate` passes from monorepo root
- [ ] No new runtime dependencies in operative (storage is already a dependency)
- [ ] All new modules follow factory-function pattern
- [ ] All public functions have JSDoc descriptions

## Verification Commands

```bash
bun test packages/operative/src/session/     # Unit tests
bun test --coverage packages/operative/      # Coverage
bun test packages/gateway/                   # Gateway tests
turbo run check-types --filter=operative     # Type check
turbo run check-types --filter=gateway       # Type check
turbo run validate                           # Full pipeline
```

<promise>SESSION_PERSISTENCE_COMPLETE</promise>
<promise>SESSION_PERSISTENCE_FAILED</promise>
