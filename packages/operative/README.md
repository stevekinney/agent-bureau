# Operative

`operative` is the provider-agnostic agent runtime for Agent Bureau. It owns the loop that assembles context, calls a generate function, executes tools, records steps, handles stop conditions, emits events, manages sessions, and coordinates advanced runtime behavior.

## What It Does

- Defines agents with `defineAgent()` and runs them with `run()` or `createRun()`.
- Executes tools through `armorer` and conversation history through `conversationalist`.
- Accepts caller-provided generate functions instead of importing model SDKs.
- Provides sessions, session stores, durable run support, scheduler primitives, and heartbeat utilities.
- Adds hooks for generation, tool execution, context assembly, validation, run lifecycle, and error handling.
- Provides guardrails, retry mutators, cache middleware, context compaction, streaming, backpressure, budgets, handoffs, subagents, and supervisors.

## How It Works

The core loop starts with an agent definition, a conversation, tools, and a `GenerateFunction`. For each step, it prepares context, calls the generate function, validates the response, executes requested tools, appends tool results back to the conversation, emits typed events, and evaluates stop conditions.

Everything provider-specific stays outside the package. `herald` can supply generate functions for common providers, but callers can pass any function that satisfies the runtime type. Durable execution, scheduler tasks, and session persistence build on the same loop so product surfaces can recover or resume runs without changing agent code.

## Project Role

`operative` is the center of the Agent Bureau runtime graph. `gateway` uses it to run requests and scheduler tasks, `operative/store` observes run state and action history, `memory` and `skills` attach through hooks and tools, `armorer` supplies actions, and `conversationalist` supplies the conversation model.

## Workspace Entry Points

- `defineAgent()`
- `run()` and `createRun()`
- `operative/store` for the internal run store, action log, snapshots, and store events
- `operative/test` for runtime and store test helpers used by package-boundary tests
- `createAgentSession()`, `createSessionStore()`, and `resumeSession()`
- `createScheduler()`, `createHeartbeat()`, and durable run helpers
- Hook helpers such as `composeHooks()`, `runOnce()`, `onlyOnStep()`, and `withTimeout()`
- Guardrail helpers such as `createGuardrails()` and `createPromptInjectionDetector()`
- Context helpers such as `createContextAssembler()` and `createTokenBudget()`
- Streaming helpers such as `withStreaming()` and `withEnhancedStreaming()`
- Supervisor and subagent helpers such as `createSupervisor()` and `createSubagentTool()`

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
```
