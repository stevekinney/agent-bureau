// Type-level contract for AB-21. This file is checked by `tsc --noEmit`; it
// is not a runtime Bun test.

import { createToolbox } from 'armorer';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import type { AgentRun } from './agent-run';
import { createAgentRun } from './agent-run';
import { noToolCalls } from './conditions/predicates';
import type { CreateLazyAgentOptions, LazyAgentLoader } from './create-lazy-agent';
import { createLazyAgent } from './create-lazy-agent';
import { createActiveRun } from './create-run';
import type { RunnableAgent } from './runnable-agent';
import type { GenerateFunction, GenerateResponse } from './types';

const response = { content: 'typed', toolCalls: [] } satisfies GenerateResponse;
const generate: GenerateFunction = () => Promise.resolve(response);

function buildRun<O, H extends boolean>(hasOutput: H): AgentRun<O, H> {
  const conversation = new Conversation();
  conversation.appendUserMessage('typed');
  const activeRun = createActiveRun({
    generate,
    toolbox: createToolbox([]),
    conversation,
    stopWhen: noToolCalls(),
  });
  return createAgentRun<O, H>(activeRun, { hasOutput });
}

const untypedAgent: RunnableAgent<never, false> = {
  name: 'untyped',
  run: () => buildRun(false),
};

const _outputSchema = z.object({ summary: z.string() });
type TypedOutput = z.output<typeof _outputSchema>;

const typedAgent: RunnableAgent<TypedOutput, true> = {
  name: 'typed',
  run: () => buildRun(true),
};

// -- Direct agent ------------------------------------------------------------

const directLazy: RunnableAgent<never, false> = createLazyAgent(() => untypedAgent);
void directLazy;

const directTypedLazy: RunnableAgent<TypedOutput, true> = createLazyAgent(() => typedAgent);
void directTypedLazy;

// -- Named, default, barrel, and literal dynamic imports ---------------------

const namedLazy: RunnableAgent<never, false> = createLazyAgent(() =>
  import('./create-lazy-agent-type-fixtures').then((module) => module.namedAgent),
);
void namedLazy;

const defaultLazy: RunnableAgent<never, false> = createLazyAgent(() =>
  import('./create-lazy-agent-type-fixtures').then((module) => module.default),
);
void defaultLazy;

const barrelLazy: RunnableAgent<never, false> = createLazyAgent(() =>
  import('./create-lazy-agent-type-barrel').then((module) => module.namedAgent),
);
void barrelLazy;

const literalImportLazy: RunnableAgent<never, false> = createLazyAgent(() =>
  import('./create-lazy-agent-type-fixtures').then(({ namedAgent: selected }) => selected),
);
void literalImportLazy;

// -- Widened runtime module: RunnableAgent<unknown, boolean> ----------------

declare const widenedUnknownModule: Promise<unknown>;

// @ts-expect-error — callers must select and narrow the export before passing it to createLazyAgent.
const unknownModuleLazy = createLazyAgent(() => widenedUnknownModule);
void unknownModuleLazy;

const narrowedWidenedLazy: RunnableAgent<unknown, boolean> = createLazyAgent(async () => {
  const module = await widenedUnknownModule;
  if (
    typeof module === 'object' &&
    module !== null &&
    'run' in module &&
    typeof module.run === 'function'
  ) {
    return module as RunnableAgent<unknown, boolean>;
  }
  return untypedAgent;
});
void narrowedWidenedLazy;

// -- Loader accepts a promise-like agent too ---------------------------------

const promiseLikeLoader: LazyAgentLoader<never, false> = () => Promise.resolve(untypedAgent);
void promiseLikeLoader;

const options: CreateLazyAgentOptions = { label: 'typed-agent' };
void options;

// @ts-expect-error — a selector overload is not part of the public contract.
const optionsWithSelector: CreateLazyAgentOptions = { select: (module: unknown) => module };
void optionsWithSelector;

const moduleObjectLoader = () => import('./create-lazy-agent-type-fixtures');

// @ts-expect-error — module objects are not accepted; the caller must select the RunnableAgent export.
const moduleObjectLazy = createLazyAgent(moduleObjectLoader);
void moduleObjectLazy;

// `createLazyAgent`'s return value is an ordinary `RunnableAgent`, with no
// stateful helper API and no thenable surface.
type RunnableAgentWithPreload = RunnableAgent<never, false> & { preload: () => void };

// @ts-expect-error — the lazy wrapper has no stateful helper API beyond RunnableAgent.
const lazyWithPreload: RunnableAgentWithPreload = directLazy;
void lazyWithPreload;

// @ts-expect-error — RunnableAgent (and its AgentRun) are never thenable.
const thenableLazy: PromiseLike<unknown> = directLazy;
void thenableLazy;
