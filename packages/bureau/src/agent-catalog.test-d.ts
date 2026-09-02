// Type-level tripwire (AB-22): every shape `AgentDefinitions` must accept —
// a plain `createAgent` agent, a schema-backed one, and a `createLazyAgent`
// wrapper around either — must bind through `createBureau<const D extends
// AgentDefinitions>`'s exact generic-constraint site without a cast. If this
// file stops compiling, `AgentDefinitions`'s value bound regressed — see its
// doc comment in `./agent-catalog.ts` for why it's a two-member union
// (`RunnableAgent<never, false> | RunnableAgent<any, true>`), not one
// instantiation of `RunnableAgent<O, H>`.

import { createAgent, createLazyAgent } from '@lostgradient/operative';
import { createMockGenerate } from '@lostgradient/operative/test';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';

const plainAgent = createAgent({ generate: createMockGenerate([]), name: 'plain' });

const schemaAgent = createAgent({
  generate: createMockGenerate([]),
  name: 'schema',
  output: z.object({ a: z.string() }),
});

const lazyPlainAgent = createLazyAgent(() => Promise.resolve(plainAgent));
const lazySchemaAgent = createLazyAgent(() => Promise.resolve(schemaAgent));

// Mirrors `createBureau`'s actual generic-constraint binding site exactly —
// a `satisfies AgentDefinitions` check on the raw object literal is NOT
// equivalent: constraint checking during "const" type-parameter inference
// and a direct `satisfies` comparison both fully expand `RunnableAgent<O,
// H>`'s conditional return types per key, so this file exercises the real
// path rather than assuming a difference that doesn't exist.
declare function acceptAgentDefinitions<const D extends AgentDefinitions>(agents: D): D;

const definitions = acceptAgentDefinitions({
  plain: plainAgent,
  schema: schemaAgent,
  lazyPlain: lazyPlainAgent,
  lazySchema: lazySchemaAgent,
});

// Literal keys and each entry's own precise type must survive the generic
// binding — this is the actual "const D" contract `createBureau` relies on
// for `bureau.run(name, ...)`'s per-name output-type inference.
declare const checkPlain: (typeof definitions)['plain'];
declare const checkSchema: (typeof definitions)['schema'];
void checkPlain;
void checkSchema;
void definitions;
