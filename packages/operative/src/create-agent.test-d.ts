// Type spike pinning the fix for issue #271: "Toolbox is invariant in its
// tool-tuple parameter: bare Toolbox cannot accept createToolbox([...])
// output."
//
// Conventions (matching packages/armorer/src/toolbox-variance.test-d.ts and
// packages/conversationalist/src/state-snapshot.test-d.ts):
//   - All `declare const` are type-level only; nothing runs at runtime.
//   - This file is validated by `tsc`/`check-types` ONLY — never run under
//     `bun test`. Running it as a script produces spurious syntax errors;
//     the only oracle here is the TypeScript compiler.
//
// PR #263 (issue #258) shipped `CreateAgentOptions.toolbox` so a stateless
// chat host can pass a pre-built `Toolbox` and call `toolbox.resumeApproval()`
// across requests. That field (and `RunOptions.toolbox`) is typed
// `AnyToolbox`, armorer's erased supertype every `Toolbox<TTools>`
// structurally satisfies — this pins that a real `createToolbox([...])`
// result assigns to both with no cast and no `any`.

import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import type { CreateAgentOptions } from './create-agent';
import { createAgent } from './create-agent';
import type { RunOptions } from './types';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Look up the current weather for a location.',
  input: z.object({ location: z.string() }),
  execute: () => Promise.resolve({ temperature: 72 }),
});

// A concretely-typed toolbox, exactly as the issue's repro constructs it.
const concreteToolbox = createToolbox([weatherTool]);

// ---------------------------------------------------------------------------
// 1. `CreateAgentOptions.toolbox` accepts a concretely-typed toolbox with no
//    cast — the motivating example from #258/#263.
// ---------------------------------------------------------------------------

declare const mockGenerate: CreateAgentOptions['generate'];

const optionsWithToolbox: CreateAgentOptions = {
  generate: mockGenerate,
  toolbox: concreteToolbox,
};
void optionsWithToolbox;

// `createAgent` itself accepts it too, end-to-end.
const agent = createAgent({
  generate: mockGenerate,
  toolbox: concreteToolbox,
});
void agent;

// ---------------------------------------------------------------------------
// 2. `RunOptions.toolbox` (the agent loop's own entry point) accepts the same
//    concretely-typed toolbox with no cast.
// ---------------------------------------------------------------------------

declare const runGenerate: RunOptions['generate'];
declare const runConversation: RunOptions['conversation'];

const runOptions: RunOptions = {
  generate: runGenerate,
  toolbox: concreteToolbox,
  conversation: runConversation,
};
void runOptions;
