// Type-level contract for COR-814's typed parent-child signals. This file is
// checked by `tsc --noEmit`; it is not a runtime Bun test.

import { z } from 'zod';

import { type ChildRunHandle, dispatchChildRun, type SignaledChildRunHandle } from './child-run';
import {
  type ChildEventOutcome,
  type ChildSignalOutcome,
  defineChildSignals,
  readParentSignals,
} from './child-signals';
import type { RunnableAgent } from './runnable-agent';

declare const agent: RunnableAgent;

const contract = defineChildSignals({
  signals: { focus: z.object({ topic: z.string() }) },
  events: { progress: z.object({ percent: z.number() }) },
});

// Supplying a contract selects the signaled handle, typed by that contract.
const signaled = dispatchChildRun(agent, 'go', {
  agentName: 'worker',
  parentRunId: 'p',
  signals: contract,
});
const signaledHandle: SignaledChildRunHandle<never, false, typeof contract> = signaled;
void signaledHandle;

const sent: Promise<ChildSignalOutcome<'focus'>> = signaled.signals.send('focus', {
  topic: 'owls',
});
void sent;

// @ts-expect-error — `focus` requires a string `topic`.
void signaled.signals.send('focus', { topic: 1 });

// @ts-expect-error — the contract declares no `resume` signal.
void signaled.signals.send('resume', {});

// @ts-expect-error — `progress` is an event the child emits, not a signal the parent sends.
void signaled.signals.send('progress', { percent: 1 });

signaled.signals.on('progress', (message) => {
  const percent: number = message.payload.percent;
  const name: 'progress' = message.name;
  void percent;
  void name;
});

// @ts-expect-error — `focus` is a signal the parent sends, not an event it observes.
signaled.signals.on('focus', () => {});

// Without a contract the plain handle has no `signals` endpoint.
const plain = dispatchChildRun(agent, 'go', { agentName: 'worker', parentRunId: 'p' });
const plainHandle: ChildRunHandle = plain;
void plainHandle;
// @ts-expect-error — no contract, no channel.
void plain.signals;

// The child-side port is typed by the contract it is read with.
const port = readParentSignals(undefined, contract);
if (port !== undefined) {
  port.onSignal('focus', (message) => {
    const topic: string = message.payload.topic;
    void topic;
  });
  const emitted: ChildEventOutcome<'progress'> = port.emit('progress', { percent: 50 });
  void emitted;

  // @ts-expect-error — `progress` requires a numeric `percent`.
  port.emit('progress', { percent: 'half' });

  // @ts-expect-error — the child cannot emit a parent signal name.
  port.emit('focus', { topic: 'x' });
}
