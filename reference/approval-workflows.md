# Approval Workflows

## Overview

Operative has elicitation—asking the user a question and waiting for a response. But elicitation is a generic prompt, not an approval gate. There's no pattern for "pause before executing this tool, wait for human approval, resume or abort." The soul-approval system in the memory package is domain-specific. Production agents need general-purpose approval workflows with risk tiers, durable pause/resume, and audit logging.

This work adds an approval framework to operative that integrates with the `beforeToolExecution` hook, supports configurable risk tiers, and logs all decisions.

## What Exists Today

Read these files to understand the current state:

- `packages/operative/src/types.ts` — `OnElicitation`, `ElicitationRequest`, `BeforeToolExecutionHook`, `ToolExecutionHookContext`
- `packages/operative/src/hooks.ts` — `OperativeHookMap`
- `packages/operative/src/loop.ts` — where `beforeToolExecution` hooks are called
- `packages/memory/src/identity/soul-approval.ts` — domain-specific approval pattern
- `packages/operative/src/agent-session.ts` — `AgentSession` for persisting approval state

## Product Requirements

### PR-1: Risk Tier Classification

Classify tool calls by risk level:

```typescript
type RiskTier = 'auto' | 'notify' | 'approve';

interface RiskClassification {
  tier: RiskTier;
  reason: string;
}

type RiskClassifier = (
  toolCall: ToolCall,
  context: ToolExecutionHookContext,
) => RiskClassification;
```

- **`auto`**: Execute immediately without human involvement.
- **`notify`**: Execute immediately but notify the human asynchronously.
- **`approve`**: Pause execution and wait for explicit human approval before proceeding.

### PR-2: Built-in Risk Classifiers

```typescript
/** Classify by tool name patterns. */
function createToolNameClassifier(rules: {
  approve?: string[];   // Tool names requiring approval
  notify?: string[];    // Tool names requiring notification
  auto?: string[];      // Tool names that auto-execute (default for unlisted)
}): RiskClassifier;

/** Classify by argument patterns. */
function createArgumentClassifier(rules: {
  approve?: Array<{ tool: string; argPattern: RegExp }>;
  notify?: Array<{ tool: string; argPattern: RegExp }>;
}): RiskClassifier;

/** Compose multiple classifiers. Highest risk tier wins. */
function composeClassifiers(...classifiers: RiskClassifier[]): RiskClassifier;
```

### PR-3: Approval Handler

The mechanism for requesting and receiving approval:

```typescript
interface ApprovalRequest {
  id: string;
  toolCall: ToolCall;
  risk: RiskClassification;
  context: {
    step: number;
    conversationSummary: string;
    agentName?: string;
  };
  requestedAt: number;
}

type ApprovalDecision =
  | { approved: true; approvedBy?: string; comment?: string }
  | { approved: false; reason: string; approvedBy?: string };

type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;
```

Approval handlers are pluggable. Implementations might include:
- CLI prompt (for local development)
- WebSocket notification via gateway (for web UI)
- External webhook (for Slack/Teams approval flows)

```typescript
/** Simple CLI-based approval for development. */
function createCLIApprovalHandler(): ApprovalHandler;

/** Approval via elicitation (uses operative's OnElicitation). */
function createElicitationApprovalHandler(
  onElicitation: OnElicitation,
): ApprovalHandler;
```

### PR-4: Approval Hook

`createApprovalHook()` returns a `BeforeToolExecutionHook` that integrates risk classification and approval:

```typescript
interface ApprovalHookOptions {
  classifier: RiskClassifier;
  handler: ApprovalHandler;
  /** Called for 'notify' tier tools after execution. */
  onNotify?: (toolCall: ToolCall, result: ToolExecutionResult) => void;
  /** Timeout for approval requests in ms. Default: 300_000 (5 min). */
  timeout?: number;
  /** Action on timeout. Default: 'deny'. */
  onTimeout?: 'deny' | 'approve';
  /** Store for audit log. */
  auditStore?: KeyValueStore;
}

function createApprovalHook(options: ApprovalHookOptions): BeforeToolExecutionHook;
```

The hook:
1. Classifies each tool call in the step
2. For `auto` tools: pass through unchanged
3. For `notify` tools: pass through, schedule async notification
4. For `approve` tools: pause, request approval, wait for decision
5. If denied: remove the tool call from the array (preventing execution)
6. Log all decisions to audit store when provided

### PR-5: Audit Log

Record all approval decisions for compliance:

```typescript
interface AuditEntry {
  id: string;
  timestamp: number;
  toolCall: { name: string; arguments: unknown };
  risk: RiskClassification;
  decision: ApprovalDecision;
  duration: number; // ms between request and decision
  runId?: string;
  step: number;
}

interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
  query(options: AuditQueryOptions): Promise<AuditEntry[]>;
  count(options?: AuditQueryOptions): Promise<number>;
}

interface AuditQueryOptions {
  toolName?: string;
  tier?: RiskTier;
  approved?: boolean;
  since?: number;
  limit?: number;
}

function createAuditLog(store: KeyValueStore): AuditLog;
```

### PR-6: Batch Approval

When multiple tool calls in a single step require approval, present them as a batch rather than one-by-one:

```typescript
interface BatchApprovalRequest {
  id: string;
  toolCalls: Array<{ toolCall: ToolCall; risk: RiskClassification }>;
  context: ApprovalRequest['context'];
  requestedAt: number;
}

type BatchApprovalDecision = Array<{
  toolCallId: string;
  decision: ApprovalDecision;
}>;

type BatchApprovalHandler = (request: BatchApprovalRequest) => Promise<BatchApprovalDecision>;
```

When a `batchHandler` is provided, multiple `approve`-tier tool calls are grouped into a single request.

## Architecture

### New Files

In `packages/operative/src/approval/`:

- `types.ts` — all types above
- `classifiers.ts` — `createToolNameClassifier()`, `createArgumentClassifier()`, `composeClassifiers()`
- `create-approval-hook.ts` — `createApprovalHook()` factory
- `handlers.ts` — `createElicitationApprovalHandler()`
- `audit-log.ts` — `createAuditLog()` factory
- `index.ts` — re-exports

### Extended Files

- `packages/operative/src/index.ts` — re-export approval modules

## Implementation Order (TDD)

### Phase 1: Risk Classifiers

1. Write tests:
   - `createToolNameClassifier({ approve: ['delete'] })` classifies `delete` as `approve`
   - Unlisted tools default to `auto`
   - `createArgumentClassifier` matches regex patterns in tool arguments
   - `composeClassifiers()` returns highest tier when multiple classifiers match
   - Tier ordering: `approve` > `notify` > `auto`
2. Implement `classifiers.ts`
3. Verify: `bun test packages/operative/src/approval/classifiers.test.ts`

### Phase 2: Audit Log

1. Write tests:
   - `record()` persists entry
   - `query()` filters by tool name
   - `query()` filters by tier
   - `query()` filters by approved/denied
   - `query()` filters by time range
   - `query()` respects limit
   - `count()` returns accurate count
   - Empty query returns all entries
2. Implement `audit-log.ts`
3. Verify: `bun test packages/operative/src/approval/audit-log.test.ts`

### Phase 3: Approval Handlers

1. Write tests for `createElicitationApprovalHandler()`:
   - Calls `onElicitation` with approval schema
   - User approving → `{ approved: true }`
   - User denying → `{ approved: false, reason }`
   - `onElicitation` returning null → treated as denial
2. Implement `handlers.ts`
3. Verify: `bun test packages/operative/src/approval/handlers.test.ts`

### Phase 4: Approval Hook

1. Write tests for `createApprovalHook()`:
   - `auto` tier tools pass through unchanged
   - `approve` tier tools pause and wait for approval
   - Approved tool calls remain in the array
   - Denied tool calls removed from the array
   - `notify` tier tools pass through, notification fires after execution
   - Timeout triggers configured action (deny or approve)
   - Audit log receives all decisions
   - Multiple tool calls in one step handled correctly
   - All `auto` tier → no approval request made
   - Mixed tiers → only `approve` tier tools trigger approval
2. Implement `create-approval-hook.ts`
3. Verify: `bun test packages/operative/src/approval/create-approval-hook.test.ts`

### Phase 5: Batch Approval

1. Write tests:
   - Multiple `approve` tools grouped into single batch request
   - Per-tool decisions applied correctly
   - Mix of approved and denied in same batch
   - Falls back to individual handler when no batch handler provided
2. Extend `create-approval-hook.ts`
3. Verify: `bun test packages/operative/src/approval/`

### Phase 6: Integration

1. Wire exports
2. Run full suite: `turbo run validate`

## Acceptance Criteria

- [ ] `createApprovalHook()` exported from `operative`
- [ ] `createToolNameClassifier()` classifies tools by name
- [ ] `createArgumentClassifier()` classifies by argument patterns
- [ ] `composeClassifiers()` combines classifiers with highest-tier-wins
- [ ] `auto` tier tools execute without approval
- [ ] `notify` tier tools execute and notify asynchronously
- [ ] `approve` tier tools pause until human decision
- [ ] Denied tools removed from execution array
- [ ] Approval timeout triggers configurable action
- [ ] `createElicitationApprovalHandler()` bridges to operative's elicitation
- [ ] `createAuditLog()` records all decisions
- [ ] Audit log queryable by tool, tier, decision, time range
- [ ] Batch approval groups multiple tools into single request
- [ ] 100% test coverage: `bun test --coverage packages/operative/src/approval/`
- [ ] `turbo run validate` passes from monorepo root
- [ ] No new runtime dependencies
- [ ] All public functions have JSDoc descriptions

## Verification Commands

```bash
bun test packages/operative/src/approval/    # Approval tests
bun test --coverage packages/operative/      # Coverage
turbo run check-types --filter=operative     # Type check
turbo run lint --filter=operative            # Lint
turbo run validate                           # Full pipeline
```

<promise>APPROVAL_WORKFLOWS_COMPLETE</promise>
<promise>APPROVAL_WORKFLOWS_FAILED</promise>
