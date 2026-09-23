// Type-level contract for AB-234. This file is checked by `tsc --noEmit`; it
// is not a runtime Bun test.

import type { AgentRun } from './agent-run';
import type { AgentInput, AgentRunContext, RunnableAgent } from './runnable-agent';

declare const dummyRun: AgentRun;

// `run` declared as a property-typed function (not method shorthand) is
// checked CONTRAVARIANTLY: an implementation whose `run` only accepts a
// narrower input type than `AgentInput` (`string | { conversation }`) does
// not satisfy the contract. Before AB-234 (method shorthand, checked
// bivariantly), this compiled unsoundly.
const narrowRunAgent: RunnableAgent = {
  name: 'narrow',
  hasOutput: false,
  // @ts-expect-error — a `run` accepting only `string` rejects the `{ conversation }` half of `AgentInput`.
  run: (_input: string): AgentRun => dummyRun,
};
void narrowRunAgent;

// The full `AgentInput` union, and the optional `AgentRunContext`, are
// accepted — this is the shape every real `RunnableAgent` implementation
// (`createAgent`, `createLazyAgent`) actually has.
const wideRunAgent: RunnableAgent = {
  name: 'wide',
  hasOutput: false,
  run: (_input: AgentInput, _context?: AgentRunContext): AgentRun => dummyRun,
};
void wideRunAgent;

// `hasOutput` is a required runtime witness — omitting it is a type error,
// not silently defaulted.
// @ts-expect-error — `hasOutput` is required.
const missingHasOutput: RunnableAgent = {
  name: 'missing-has-output',
  run: (): AgentRun => dummyRun,
};
void missingHasOutput;
