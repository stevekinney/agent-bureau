// Type-level fixtures for AB-19 — createSubagentTool's directional,
// type-safe input/output projections. This file is checked by
// `tsc --noEmit` only; it is not a runtime Bun test (see the convention
// note in create-agent.test-d.ts).

import { z } from 'zod';

import type { AgentInput, RunnableAgent, SuccessfulRunResult } from './agent-run';
import { createAgent } from './create-agent';
import { createSubagentTool } from './create-subagent-tool';

const inputSchema = z.object({ topic: z.string() });

// ---------------------------------------------------------------------------
// 1. `agent` accepts a real `createAgent(...)` result with no adapter —
//    `StandaloneAgent<O, H>` satisfies `RunnableAgent<O, H>` structurally.
// ---------------------------------------------------------------------------

declare const mockGenerate: Parameters<typeof createAgent>[0]['generate'];

const schemaLessAgent = createAgent({ generate: mockGenerate });
void createSubagentTool({
  name: 'schema-less',
  description: 'A schema-less child',
  agent: schemaLessAgent,
  agentName: 'child',
  input: inputSchema,
});

const schemaBackedAgent = createAgent({
  generate: mockGenerate,
  output: z.object({ answer: z.string() }),
});
void createSubagentTool({
  name: 'schema-backed',
  description: 'A schema-backed child',
  agent: schemaBackedAgent,
  agentName: 'child',
  input: inputSchema,
  // 5. `toToolOutput` sees the schema-backed child's typed `output` field —
  //    `.answer` resolves with no cast.
  toToolOutput: (result) => result.output?.answer,
});

// ---------------------------------------------------------------------------
// 2. `toAgentInput` receives the input schema's PARSED output — a typed
//    `{ topic: string }`, never `unknown` — and must return `AgentInput`.
// ---------------------------------------------------------------------------

void createSubagentTool({
  name: 'parsed-input',
  description: 'toAgentInput sees the parsed shape',
  agent: schemaLessAgent,
  agentName: 'child',
  input: inputSchema,
  toAgentInput: (parsed) => {
    // `parsed.topic` — not `(parsed as { topic: string }).topic` — proves
    // the parameter is typed to the schema's output, not `unknown`.
    const topic: string = parsed.topic;
    return topic;
  },
});

// 3. `toAgentInput` may also return the `{ conversation }` form of
//    `AgentInput` — a conversation-history child input.
declare const conversationInput: AgentInput & { conversation: unknown };
void createSubagentTool({
  name: 'conversation-input',
  description: 'toAgentInput resumes a conversation',
  agent: schemaLessAgent,
  agentName: 'child',
  input: inputSchema,
  toAgentInput: () => conversationInput,
});

// ---------------------------------------------------------------------------
// 4. Default `toToolOutput` (omitted) — the tool returns a plain `string`
//    for a schema-less child, matching the pre-AB-19 default.
// ---------------------------------------------------------------------------

void createSubagentTool({
  name: 'default-output',
  description: 'No toToolOutput supplied',
  agent: schemaLessAgent,
  agentName: 'child',
  input: inputSchema,
});

// `createSubagentTool`'s fourth generic (`TToolOutput`) DECLARES a default
// of `string` — the type-level counterpart to "a schema-less child with no
// `toToolOutput` returns a string" (proven at runtime in
// create-subagent-tool.test.ts). Only `TInput` is pinned below; leaving
// `TOutput`/`THasOutput`/`TToolOutput` unspecified resolves each to its
// declared default. The tool object is itself callable
// (`(params: unknown): Promise<TReturn>` on armorer's `Tool`), so its
// call-signature return type reflects `TToolOutput` directly.
declare const _defaultOutputTool: ReturnType<typeof createSubagentTool<{ topic: string }>>;
type DefaultToolOutput = Awaited<ReturnType<typeof _defaultOutputTool>>;
const defaultToolOutputIsString: DefaultToolOutput extends string ? true : false = true;
void defaultToolOutputIsString;

// ---------------------------------------------------------------------------
// 6. A synchronous `toToolOutput`.
// ---------------------------------------------------------------------------

void createSubagentTool({
  name: 'sync-output',
  description: 'A synchronous toToolOutput',
  agent: schemaLessAgent,
  agentName: 'child',
  input: inputSchema,
  toToolOutput: (result: SuccessfulRunResult) => result.content.length,
});

// ---------------------------------------------------------------------------
// 7. An asynchronous `toToolOutput`.
// ---------------------------------------------------------------------------

void createSubagentTool({
  name: 'async-output',
  description: 'An asynchronous toToolOutput',
  agent: schemaLessAgent,
  agentName: 'child',
  input: inputSchema,
  toToolOutput: async (result: SuccessfulRunResult) => {
    await Promise.resolve();
    return result.content.length;
  },
});

// ---------------------------------------------------------------------------
// 8. `RunnableAgent` narrower-than-`StandaloneAgent` fit: a hand-rolled
//    object satisfying only the minimal `RunnableAgent` shape (no `.name`)
//    is still accepted — proving `agent` does not require the full AB-15
//    `RunnableAgent` (which also carries `name`).
// ---------------------------------------------------------------------------

declare const minimalAgent: RunnableAgent<never, false>;
void createSubagentTool({
  name: 'minimal-agent',
  description: 'A hand-rolled RunnableAgent with no .name',
  agent: minimalAgent,
  agentName: 'child',
  input: inputSchema,
});

// ---------------------------------------------------------------------------
// 9. `treatMaximumStepsAsError` no longer exists on the options bag.
// ---------------------------------------------------------------------------

void createSubagentTool({
  name: 'no-legacy-option',
  description: 'treatMaximumStepsAsError is gone',
  agent: schemaLessAgent,
  agentName: 'child',
  input: inputSchema,
  // @ts-expect-error — treatMaximumStepsAsError was removed (AB-19); every
  // non-success terminal always rejects with SubagentRunError.
  treatMaximumStepsAsError: false,
});

// ---------------------------------------------------------------------------
// 10. `run` (the pre-AB-19 callback option) is no longer accepted.
// ---------------------------------------------------------------------------

void createSubagentTool({
  name: 'no-run-callback',
  description: 'run is gone',
  agentName: 'child',
  input: inputSchema,
  // @ts-expect-error — `run` was replaced by `agent: RunnableAgent` (AB-19);
  // there is no callback overload or compatibility path.
  run: () => Promise.resolve({}),
});
