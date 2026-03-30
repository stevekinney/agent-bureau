# Guardrails

## Overview

Agent-bureau has PII regex redaction in conversationalist and tool allowlist/denylist policies in operative. What's missing is defense-in-depth: prompt injection detection on inputs, content filtering on outputs, and session tainting when suspicious activity is detected. These are the three layers that production agent systems need before exposing an agent to untrusted input.

This work adds a guardrails system that runs as hooks in operative's pipeline, with pre-model input validation (layer 1), runtime constraints (layer 2, partially exists), and post-model output filtering (layer 3).

## What Exists Today

Read these files to understand the current state:

- `packages/conversationalist/src/plugins/pii-redaction.ts` — `createPIIRedactionPlugin()`, regex-based PII redaction
- `packages/operative/src/create-policy-enforcement-hook.ts` — `createPolicyEnforcementHook()`, tool allow/denylist
- `packages/operative/src/hooks.ts` — `OperativeHookMap` (hook points where guardrails integrate)
- `packages/operative/src/types.ts` — `PrepareStepHook`, `BeforeToolExecutionHook`, `ValidateResponseHook`
- `packages/armorer/src/types.ts` — `ToolExecutionResult` (what output filtering inspects)

## Product Requirements

### PR-1: Input Guardrail Framework

A `createInputGuardrail()` factory that produces a `PrepareStepHook` for operative. It inspects user messages before they reach the model:

```typescript
interface InputGuardrailOptions {
  /** Detectors to run on user input. */
  detectors: InputDetector[];
  /** Action when a detector trips. Default: 'block'. */
  action?: 'block' | 'warn' | 'sanitize';
  /** Called when a detector trips. */
  onTriggered?: (event: GuardrailTriggeredEvent) => void;
  /** Run detectors in parallel (default) or sequentially. */
  mode?: 'parallel' | 'sequential';
}

interface InputDetector {
  name: string;
  /** Returns a detection result. Must be fast (< 50ms for rule-based). */
  detect: (input: string, context: DetectorContext) => Promise<DetectionResult>;
}

interface DetectorContext {
  step: number;
  conversation: Conversation;
  sessionTainted: boolean;
}

interface DetectionResult {
  triggered: boolean;
  confidence: number; // 0-1
  category: string;
  detail?: string;
  /** Sanitized version of the input (used when action='sanitize'). */
  sanitized?: string;
}

interface GuardrailTriggeredEvent {
  detector: string;
  category: string;
  confidence: number;
  action: 'block' | 'warn' | 'sanitize';
  input: string;
  detail?: string;
}
```

When `action` is `'block'`, the hook returns a `GenerateResponse` with a refusal message instead of calling the model. When `'sanitize'`, it rewrites the user message before the model sees it.

### PR-2: Built-in Input Detectors

Ship detectors for common threat patterns:

**Prompt injection detector**: Pattern-matching for known injection techniques:
- System prompt override attempts (`"ignore previous instructions"`, `"you are now"`, `"new instructions:"`)
- Role confusion attacks (`"as an AI language model"`, `"[SYSTEM]"`, delimiter injection)
- Encoding-based attacks (base64-encoded instructions, unicode smuggling)

```typescript
function createPromptInjectionDetector(options?: {
  /** Additional patterns to match. */
  customPatterns?: RegExp[];
  /** Confidence threshold. Default: 0.7. */
  threshold?: number;
}): InputDetector;
```

**Topic boundary detector**: Ensures the conversation stays within configured domains:

```typescript
function createTopicBoundaryDetector(options: {
  /** Allowed topics/domains. */
  allowedTopics: string[];
  /** Keywords that indicate off-topic input. */
  blockedKeywords?: string[];
}): InputDetector;
```

**Input length detector**: Rejects suspiciously long inputs that may be injection payloads:

```typescript
function createInputLengthDetector(options?: {
  /** Maximum character count. Default: 10_000. */
  maxLength?: number;
}): InputDetector;
```

### PR-3: Output Guardrail Framework

A `createOutputGuardrail()` factory that produces a `ValidateResponseHook` for operative. It inspects model outputs before they reach the user:

```typescript
interface OutputGuardrailOptions {
  /** Validators to run on model output. */
  validators: OutputValidator[];
  /** Action when a validator trips. Default: 'block'. */
  action?: 'block' | 'warn' | 'redact';
  /** Called when a validator trips. */
  onTriggered?: (event: OutputGuardrailTriggeredEvent) => void;
  /** Replacement text when action='block'. Default: configurable refusal. */
  blockMessage?: string;
}

interface OutputValidator {
  name: string;
  validate: (output: string, context: ValidatorContext) => Promise<ValidationResult>;
}

interface ValidatorContext {
  step: number;
  conversation: Conversation;
  toolCalls: readonly ToolCallInput[];
}

interface ValidationResult {
  valid: boolean;
  category: string;
  confidence: number;
  detail?: string;
  /** Redacted version of the output (used when action='redact'). */
  redacted?: string;
}
```

### PR-4: Built-in Output Validators

**Hallucination detector** (heuristic): Flags outputs that claim specific facts without grounding in the conversation context or tool results:

```typescript
function createGroundingValidator(options?: {
  /** Minimum ratio of claims that must be grounded. Default: 0.8. */
  groundingThreshold?: number;
}): OutputValidator;
```

**PII leakage detector**: Extends the existing PII redaction to catch model-generated PII (not just user-provided):

```typescript
function createOutputPIIValidator(options?: PIIRedactionOptions): OutputValidator;
```

**Code execution safety validator**: When the model generates code in tool calls, check for dangerous patterns:

```typescript
function createCodeSafetyValidator(options?: {
  /** Patterns that indicate dangerous operations. */
  blockedPatterns?: RegExp[];
}): OutputValidator;
```

### PR-5: Session Tainting

When a guardrail detector trips with confidence above a threshold, mark the entire session as tainted. Tainted sessions apply stricter guardrails for all subsequent messages:

```typescript
interface SessionTaintOptions {
  /** Confidence threshold to taint the session. Default: 0.9. */
  taintThreshold?: number;
  /** Additional detectors to activate on tainted sessions. */
  escalatedDetectors?: InputDetector[];
  /** Additional validators to activate on tainted sessions. */
  escalatedValidators?: OutputValidator[];
  /** Called when session becomes tainted. */
  onTainted?: (event: SessionTaintedEvent) => void;
}

interface SessionTaintedEvent {
  reason: string;
  detector: string;
  confidence: number;
  step: number;
}
```

Taint state is tracked in the agent session metadata and persists across run boundaries.

### PR-6: Guardrail Composition

Combine input and output guardrails into a single `createGuardrails()` factory that returns all necessary hooks:

```typescript
interface GuardrailsOptions {
  input?: InputGuardrailOptions;
  output?: OutputGuardrailOptions;
  taint?: SessionTaintOptions;
}

interface GuardrailHooks {
  prepareStep: PrepareStepHook;
  validateResponse: ValidateResponseHook;
}

function createGuardrails(options: GuardrailsOptions): GuardrailHooks;
```

## Architecture

### New Files

In `packages/operative/src/guardrails/`:

- `types.ts` — all types above
- `input-guardrail.ts` — `createInputGuardrail()` factory
- `output-guardrail.ts` — `createOutputGuardrail()` factory
- `session-taint.ts` — session tainting logic
- `create-guardrails.ts` — `createGuardrails()` composition factory
- `index.ts` — re-exports

In `packages/operative/src/guardrails/detectors/`:

- `prompt-injection.ts` — `createPromptInjectionDetector()`
- `topic-boundary.ts` — `createTopicBoundaryDetector()`
- `input-length.ts` — `createInputLengthDetector()`

In `packages/operative/src/guardrails/validators/`:

- `grounding.ts` — `createGroundingValidator()`
- `output-pii.ts` — `createOutputPIIValidator()`
- `code-safety.ts` — `createCodeSafetyValidator()`

### Extended Files

- `packages/operative/src/index.ts` — re-export guardrails
- Existing PII redaction in conversationalist stays unchanged (guardrails layer uses it internally)

## Implementation Order (TDD)

### Phase 1: Prompt Injection Detector

1. Write tests:
   - Detects `"ignore previous instructions"` variants
   - Detects `"you are now a..."` role override
   - Detects `"[SYSTEM]"` delimiter injection
   - Detects base64-encoded instruction blocks
   - Does NOT false-positive on normal conversational text
   - Does NOT false-positive on code snippets containing similar strings
   - Custom patterns extend default set
   - Confidence scales with number of patterns matched
   - Returns `triggered: false` for clean input
2. Implement `prompt-injection.ts`
3. Verify: `bun test packages/operative/src/guardrails/detectors/prompt-injection.test.ts`

### Phase 2: Topic Boundary and Length Detectors

1. Write tests for each detector
2. Implement `topic-boundary.ts` and `input-length.ts`
3. Verify: `bun test packages/operative/src/guardrails/detectors/`

### Phase 3: Input Guardrail Framework

1. Write tests for `createInputGuardrail()`:
   - `action: 'block'` returns refusal response when detector trips
   - `action: 'warn'` fires callback but continues to model
   - `action: 'sanitize'` rewrites input before model sees it
   - Multiple detectors run in parallel by default
   - Sequential mode runs detectors in order, stops on first trigger
   - `onTriggered` callback receives correct event
   - Clean input passes through unchanged
   - Detector errors caught and logged (don't block the agent)
2. Implement `input-guardrail.ts`
3. Verify: `bun test packages/operative/src/guardrails/input-guardrail.test.ts`

### Phase 4: Output Validators

1. Write tests for each validator
2. Implement `grounding.ts`, `output-pii.ts`, `code-safety.ts`
3. Verify: `bun test packages/operative/src/guardrails/validators/`

### Phase 5: Output Guardrail Framework

1. Write tests for `createOutputGuardrail()`:
   - `action: 'block'` replaces output with refusal message
   - `action: 'warn'` fires callback but returns original
   - `action: 'redact'` returns sanitized version
   - Multiple validators all run
   - `onTriggered` callback fires with correct event
   - Valid output passes through unchanged
2. Implement `output-guardrail.ts`
3. Verify: `bun test packages/operative/src/guardrails/output-guardrail.test.ts`

### Phase 6: Session Tainting

1. Write tests:
   - High-confidence trigger taints the session
   - Tainted session activates escalated detectors
   - Taint state persists in session metadata
   - `onTainted` callback fires
   - Below-threshold triggers don't taint
2. Implement `session-taint.ts`
3. Verify: `bun test packages/operative/src/guardrails/session-taint.test.ts`

### Phase 7: Composition and Integration

1. Write tests for `createGuardrails()`:
   - Returns both `prepareStep` and `validateResponse` hooks
   - Input and output guardrails work together in a run
   - Taint state flows between input and output guardrails
2. Implement `create-guardrails.ts`
3. Wire into operative exports
4. Run full suite: `turbo run validate`

## Acceptance Criteria

- [ ] `createGuardrails()` exported from `operative`
- [ ] `createInputGuardrail()` produces a `PrepareStepHook`
- [ ] `createOutputGuardrail()` produces a `ValidateResponseHook`
- [ ] `createPromptInjectionDetector()` catches known injection patterns
- [ ] Prompt injection detector has < 5% false positive rate on normal text
- [ ] `createTopicBoundaryDetector()` enforces allowed topics
- [ ] `createInputLengthDetector()` rejects oversized inputs
- [ ] `createGroundingValidator()` flags ungrounded claims
- [ ] `createOutputPIIValidator()` catches model-generated PII
- [ ] `createCodeSafetyValidator()` flags dangerous code patterns
- [ ] `action: 'block'` prevents model output from reaching the user
- [ ] `action: 'sanitize'` rewrites input before model sees it
- [ ] `action: 'redact'` sanitizes output before returning
- [ ] Session tainting persists across runs via session metadata
- [ ] Tainted sessions activate escalated detectors/validators
- [ ] Detector/validator errors are caught and don't crash the agent
- [ ] `onTriggered` callbacks fire with correct event data
- [ ] 100% test coverage: `bun test --coverage packages/operative/src/guardrails/`
- [ ] `turbo run validate` passes from monorepo root
- [ ] No new runtime dependencies
- [ ] All public functions have JSDoc descriptions

## Verification Commands

```bash
bun test packages/operative/src/guardrails/  # All guardrail tests
bun test --coverage packages/operative/      # Coverage
turbo run check-types --filter=operative     # Type check
turbo run lint --filter=operative            # Lint
turbo run validate                           # Full pipeline
```

<promise>GUARDRAILS_COMPLETE</promise>
<promise>GUARDRAILS_FAILED</promise>
