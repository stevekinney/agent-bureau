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

import type { AgentDefinitions, AgentHasOutput, AgentOutput } from './agent-catalog';
import { createBureau } from './create-bureau';

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

// ---------------------------------------------------------------------------
// AgentOutput / AgentHasOutput — regression coverage for a conditional-type
// expansion bug (see AgentOutput's doc comment in ./agent-catalog.ts): an
// earlier definition matched `RunnableAgent<infer O, boolean>` in one branch,
// which silently infers the WRONG type (observed: `string`, `unwrap()`'s
// no-schema branch type) for a real schema'd `StandaloneAgent<O, true>`,
// rather than the schema's own output type. These assertions fail to compile
// if that regresses.
// ---------------------------------------------------------------------------

type Definitions = typeof definitions;

function expectType<T>(_value: T): void {
  // Type-only assertion helper — no runtime behavior.
}

// Exact type-equality check (distributive-conditional trick) — `T extends U`
// alone would accept `never`/`unknown`/any supertype, which is exactly the
// class of regression this guards against (the bug this replaces inferred
// `string`, itself technically a supertype-unrelated mismatch, but a looser
// `extends` check wouldn't catch every wrong shape a future regression could
// produce).
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectEquals<A, B>(..._args: Equals<A, B> extends true ? [] : [never]): void {
  // Type-only assertion helper — no runtime behavior. Called with zero
  // arguments; a `false` Equals<A, B> makes the parameter list `[never]`,
  // so a zero-argument call fails to compile.
}

// A schema'd agent's output type is preserved EXACTLY as `{ a: string }` —
// not widened to `string`, `unknown`, or collapsed to `never`.
expectEquals<AgentOutput<Definitions, 'schema'>, { a: string }>();

// A no-schema agent's output type is exactly `never`.
expectEquals<AgentOutput<Definitions, 'plain'>, never>();

// AgentHasOutput distinguishes true/false correctly and precisely (not
// widened to `boolean`).
const schemaHasOutput: AgentHasOutput<Definitions, 'schema'> = true;
const plainHasOutput: AgentHasOutput<Definitions, 'plain'> = false;
// @ts-expect-error — AgentHasOutput<Definitions, 'schema'> is the literal
// `true`, not `boolean` — assigning `false` must fail.
const wrongSchemaHasOutput: AgentHasOutput<Definitions, 'schema'> = false;
void schemaHasOutput;
void plainHasOutput;
void wrongSchemaHasOutput;

// Lazy-wrapped agents propagate the SAME output typing as their eager
// counterparts — createLazyAgent's RunnableAgent<O, H> wrapping must not
// lose or widen it.
expectEquals<AgentOutput<Definitions, 'lazySchema'>, { a: string }>();
expectEquals<AgentOutput<Definitions, 'lazyPlain'>, never>();

// ---------------------------------------------------------------------------
// bureau.run(name, input) — literal-name output inference end to end. The
// `.output()` accessor exists ONLY for a schema'd agent's dispatched run;
// calling it on a no-schema agent's run is a compile error, not a value
// fabricated as `unknown` (AB-15's OutputMethod<O, H> contract).
// ---------------------------------------------------------------------------

async function bureauRunOutputInference() {
  const bureau = await createBureau({
    agents: { plain: plainAgent, schema: schemaAgent },
  });

  const schemaRun = bureau.run('schema', 'hi');
  const output = await schemaRun.output();
  expectType<{ a: string }>(output);

  const plainRun = bureau.run('plain', 'hi');
  // @ts-expect-error — `plainRun.output` does not exist: the `plain` agent
  // carries no `output` schema, so `AgentHasOutput` resolves `false` and
  // `OutputMethod<O, false>` has no `output()` member at all.
  void plainRun.output;

  // `bureau.agents.has` narrows a runtime string to a known literal name
  // where TypeScript permits it — inside the `if`, `name`'s type is one of
  // the catalog's literal keys, so `.get(name)` (literal-key-only) compiles.
  const name: string = 'schema';
  if (bureau.agents.has(name)) {
    bureau.agents.get(name);
  }

  // `bureau.run`'s return type must DISTRIBUTE over a union `name` (review
  // round 2, Codex — see AgentRunForName's doc comment in ./agent-catalog.ts).
  // Without distribution, calling with a name typed as a union collapses
  // AgentHasOutput to `boolean`, which resolves AgentRun's own H-conditional
  // to its `false` branch regardless of which agent is actually dispatched —
  // `unwrap()` would then type as `Promise<string>` even when the runtime
  // call resolves to the schema'd agent, silently lying about the schema
  // branch's real output shape. Asserting the schema type still appears in
  // the union return proves the distribution held.
  const unionName = 'schema' as 'plain' | 'schema';
  const unionRun = bureau.run(unionName, 'hi');
  const unionUnwrapped = unionRun.unwrap();
  expectType<Promise<string> | Promise<{ a: string }>>(unionUnwrapped);
}
void bureauRunOutputInference;
