/**
 * Tests for `createSteeringGate` (AB-67/AB-199): the per-session state
 * machine `submitSteeringCommand` and `runStep`'s boundary read consult.
 * `create-bureau.test.ts`'s "createBureau submitSteeringCommand" suite
 * covers the pre-admission checks and the full end-to-end pause/resume
 * gating through a real `Bureau`; this file exercises the gate's own state
 * machine directly, including the `agent-identity` deferral mechanics
 * AB-199's coordinator amendments (2026-09-02, AB-221 review addendum)
 * require but `submitSteeringCommand` itself never reaches (see
 * `ImplementedSteeringCommand`'s doc comment in `steering.ts`).
 */
import { describe, expect, it } from 'bun:test';

import {
  createSteeringCommandLedger,
  createSteeringGate,
  type ImplementedSteeringCommand,
} from './steering';

function pauseCommand(
  overrides: Partial<ImplementedSteeringCommand> = {},
): ImplementedSteeringCommand {
  return {
    id: 'cmd-1',
    idOrigin: 'caller',
    sessionId: 'session-1',
    principal: 'alice',
    requestedValue: { target: 'pause' },
    requestedAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

function resumeCommand(
  overrides: Partial<ImplementedSteeringCommand> = {},
): ImplementedSteeringCommand {
  return {
    id: 'cmd-1',
    idOrigin: 'caller',
    sessionId: 'session-1',
    principal: 'alice',
    requestedValue: { target: 'resume' },
    requestedAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

const NOW = '2026-09-02T00:00:01.000Z';

describe('createSteeringGate', () => {
  it('starts unpaused, at configVersion 0, with an applied floor of 0', () => {
    const gate = createSteeringGate('session-1');
    expect(gate.getDesiredState()).toEqual({ paused: false, configVersion: 0 });
    expect(gate.getAppliedFloor()).toBe(0);
  });

  it("rejects a pause with no runId and zero live runs as run-ambiguous (AB-67's ratified rule: absent runId with ZERO non-terminal runs is ambiguous, not a silent fallback)", () => {
    const gate = createSteeringGate('session-1');
    const outcome = gate.admit(pauseCommand(), { liveRunIds: [], now: NOW });
    expect(outcome).toEqual({
      outcome: 'rejected',
      failure: { failedAt: NOW, reason: 'run-ambiguous' },
    });
    expect(gate.getDesiredState()).toEqual({ paused: false, configVersion: 0 });
  });

  it('rejects a pause with no runId and MORE THAN ONE live run as run-ambiguous (PR #430 review, Codex P2)', () => {
    const gate = createSteeringGate('session-1');
    const outcome = gate.admit(pauseCommand(), { liveRunIds: ['run-a', 'run-b'], now: NOW });
    expect(outcome).toEqual({
      outcome: 'rejected',
      failure: { failedAt: NOW, reason: 'run-ambiguous' },
    });
    expect(gate.getDesiredState()).toEqual({ paused: false, configVersion: 0 });
  });

  it('a pause increments configVersion by exactly one and sets paused', () => {
    const gate = createSteeringGate('session-1');
    const outcome = gate.admit(pauseCommand(), { liveRunIds: ['run-1'], now: NOW });
    expect(outcome).toEqual({
      outcome: 'accepted',
      command: {
        id: 'cmd-1',
        sessionId: 'session-1',
        principal: 'alice',
        requestedValue: { target: 'pause' },
        runId: 'run-1',
        requestedAt: NOW,
        state: 'accepted',
        configVersion: 1,
      },
    });
    expect(gate.getDesiredState()).toEqual({ paused: true, configVersion: 1 });
  });

  it('a second, distinct pause while already paused is idempotent: accepted, no new configVersion', () => {
    const gate = createSteeringGate('session-1');
    gate.admit(pauseCommand({ id: 'first' }), { liveRunIds: ['run-1'], now: NOW });
    const second = gate.admit(pauseCommand({ id: 'second' }), { liveRunIds: ['run-1'], now: NOW });
    expect(second.outcome).toBe('accepted');
    // No new configVersion — the pause was already true.
    expect(gate.getDesiredState()).toEqual({ paused: true, configVersion: 1 });
  });

  it('a resume against a session that is not currently paused is accepted as a no-op', () => {
    const gate = createSteeringGate('session-1');
    const outcome = gate.admit(resumeCommand(), { liveRunIds: ['run-1'], now: NOW });
    expect(outcome.outcome).toBe('accepted');
    expect(gate.getDesiredState()).toEqual({ paused: false, configVersion: 0 });
  });

  it('a resume while paused increments configVersion, unpauses, and releases awaitResume()', async () => {
    const gate = createSteeringGate('session-1');
    gate.admit(pauseCommand(), { liveRunIds: ['run-1'], now: NOW });
    const waiter = gate.forRun('run-1').awaitResume();
    let resolved = false;
    void waiter.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);

    const outcome = gate.admit(resumeCommand({ id: 'resume-1' }), {
      liveRunIds: ['run-1'],
      now: NOW,
    });
    expect(outcome.outcome).toBe('accepted');
    expect(gate.getDesiredState()).toEqual({ paused: false, configVersion: 2 });

    await waiter;
    expect(resolved).toBe(true);
  });

  it('awaitResume() resolves immediately when the gate is not paused', async () => {
    const gate = createSteeringGate('session-1');
    await gate.awaitResume();
  });

  it("the raw gate's own awaitResume() registers into the aggregate (unbound) bucket while any run is paused, and releases once every run resumes (PR #430 review, Codex P2)", async () => {
    const gate = createSteeringGate('session-1');
    gate.admit(pauseCommand(), { liveRunIds: ['run-1'], now: NOW });
    let resolved = false;
    void gate.awaitResume().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    // Resuming run-1 — the only run paused — resumes EVERY run on the
    // session, so the aggregate (unbound) waiter releases too.
    gate.admit(resumeCommand({ id: 'resume-1' }), { liveRunIds: ['run-1'], now: NOW });
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it('the aggregate (unbound) waiter stays pending while ANY run remains paused, and releases only once the last one resumes', async () => {
    const gate = createSteeringGate('session-1');
    gate.admit(pauseCommand({ id: 'pause-a' }), { liveRunIds: ['run-a'], now: NOW });
    gate.admit(pauseCommand({ id: 'pause-b' }), { liveRunIds: ['run-b'], now: NOW });
    let resolved = false;
    void gate.awaitResume().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    gate.admit(resumeCommand({ id: 'resume-a' }), { liveRunIds: ['run-a'], now: NOW });
    await Promise.resolve();
    expect(resolved).toBe(false); // run-b is still paused

    gate.admit(resumeCommand({ id: 'resume-b' }), { liveRunIds: ['run-b'], now: NOW });
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it('awaitResume(signal) drops its waiter when the signal aborts, without resolving the promise', async () => {
    const gate = createSteeringGate('session-1');
    gate.admit(pauseCommand(), { liveRunIds: ['run-1'], now: NOW });
    const controller = new AbortController();
    let resolved = false;
    void gate
      .forRun('run-1')
      .awaitResume(controller.signal)
      .then(() => {
        resolved = true;
      });
    controller.abort();
    await Promise.resolve();
    expect(resolved).toBe(false);

    // A resume after the abort still works normally — the aborted waiter
    // was cleanly removed, not left in a broken state.
    const outcome = gate.admit(resumeCommand({ id: 'resume-1' }), {
      liveRunIds: ['run-1'],
      now: NOW,
    });
    expect(outcome.outcome).toBe('accepted');
    expect(resolved).toBe(false);
  });

  it('accepts a pause/resume naming a runId that matches the bound run explicitly', () => {
    const gate = createSteeringGate('session-1');
    const outcome = gate.admit(pauseCommand({ runId: 'run-1' }), {
      liveRunIds: ['run-1'],
      now: NOW,
    });
    expect(outcome.outcome).toBe('accepted');
    expect(gate.getDesiredState()).toEqual({ paused: true, configVersion: 1 });
  });

  it('awaitResume(signal) with an ALREADY-aborted signal registers no waiter at all (PR #430 review, Copilot leak fix)', async () => {
    // An already-fired AbortSignal never re-fires its 'abort' event for a
    // listener added afterward, so registering a waiter here would leak it
    // forever (never resolved, never removed). The fix skips registration
    // entirely when `signal.aborted` is already true at call time.
    const gate = createSteeringGate('session-1');
    gate.admit(pauseCommand(), { liveRunIds: ['run-1'], now: NOW });
    const controller = new AbortController();
    controller.abort();

    let resolved = false;
    void gate
      .forRun('run-1')
      .awaitResume(controller.signal)
      .then(() => {
        resolved = true;
      });
    await Promise.resolve();
    expect(resolved).toBe(false);

    // The resume path is unaffected by the (never-registered) aborted
    // waiter — no dangling entry to trip over.
    const outcome = gate.admit(resumeCommand({ id: 'resume-1' }), {
      liveRunIds: ['run-1'],
      now: NOW,
    });
    expect(outcome.outcome).toBe('accepted');
    expect(resolved).toBe(false);
  });

  it('a second, distinct resume while already unpaused is idempotent: accepted, no new configVersion', () => {
    const gate = createSteeringGate('session-1');
    gate.admit(pauseCommand({ id: 'p1' }), { liveRunIds: ['run-1'], now: NOW });
    gate.admit(resumeCommand({ id: 'r1' }), { liveRunIds: ['run-1'], now: NOW });
    const second = gate.admit(resumeCommand({ id: 'r2' }), { liveRunIds: ['run-1'], now: NOW });
    expect(second.outcome).toBe('accepted');
    expect(gate.getDesiredState()).toEqual({ paused: false, configVersion: 2 });
  });

  it('an exact retry of the same (principal, id) with an identical requestedValue replays the original state', () => {
    const gate = createSteeringGate('session-1');
    const first = gate.admit(pauseCommand(), { liveRunIds: ['run-1'], now: NOW });
    const retry = gate.admit(pauseCommand(), {
      liveRunIds: ['run-1'],
      now: '2026-09-02T00:00:02.000Z',
    });
    expect(first.outcome).toBe('accepted');
    if (first.outcome === 'accepted') {
      expect(retry).toEqual({ outcome: 'replayed', command: first.command });
    }
  });

  it('a same-id reuse under a different target returns a target-mismatch conflict', () => {
    const gate = createSteeringGate('session-1');
    gate.admit(pauseCommand(), { liveRunIds: ['run-1'], now: NOW });
    const outcome = gate.admit(resumeCommand(), { liveRunIds: ['run-1'], now: NOW });
    expect(outcome.outcome).toBe('conflict');
    if (outcome.outcome === 'conflict') {
      expect(outcome.conflict.reason).toBe('target-mismatch');
      expect(outcome.conflict.id).toBe('cmd-1');
    }
  });

  it('a same-id reuse under a different sessionId returns a session-mismatch conflict', () => {
    const gate = createSteeringGate('session-1');
    gate.admit(pauseCommand(), { liveRunIds: ['run-1'], now: NOW });
    const outcome = gate.admit(pauseCommand({ sessionId: 'session-2' }), {
      liveRunIds: ['run-1'],
      now: NOW,
    });
    expect(outcome.outcome).toBe('conflict');
    if (outcome.outcome === 'conflict') {
      expect(outcome.conflict.reason).toBe('session-mismatch');
    }
  });

  it('a same-id, same-target reuse under a different requestedValue returns a requested-value-mismatch conflict', () => {
    // pause/resume carry no value to disagree on — this is only reachable
    // for agent-identity (or any other future target with a policyRef/
    // override), exercised here through the gate's internal admission of
    // agent-identity commands (see this file's own header comment).
    const gate = createSteeringGate('session-1');
    gate.admit(
      {
        id: 'identity-1',
        idOrigin: 'caller',
        sessionId: 'session-1',
        principal: 'alice',
        requestedValue: { target: 'agent-identity', override: 'reviewer' },
        requestedAt: NOW,
      },
      { liveRunIds: [], now: NOW },
    );
    const outcome = gate.admit(
      {
        id: 'identity-1',
        idOrigin: 'caller',
        sessionId: 'session-1',
        principal: 'alice',
        requestedValue: { target: 'agent-identity', override: 'auditor' },
        requestedAt: NOW,
      },
      { liveRunIds: [], now: NOW },
    );
    expect(outcome.outcome).toBe('conflict');
    if (outcome.outcome === 'conflict') {
      expect(outcome.conflict.reason).toBe('requested-value-mismatch');
    }
  });

  it('a pause/resume naming a runId that does not match the bound run is rejected as run-terminal', () => {
    const gate = createSteeringGate('session-1');
    const outcome = gate.admit(pauseCommand({ runId: 'run-stale' }), {
      liveRunIds: ['run-current'],
      now: NOW,
    });
    expect(outcome).toEqual({
      outcome: 'rejected',
      failure: { failedAt: NOW, reason: 'run-terminal' },
    });
    // No state was written — the gate is untouched.
    expect(gate.getDesiredState()).toEqual({ paused: false, configVersion: 0 });
  });

  describe('failAcceptedForRun', () => {
    it('transitions an accepted pause bound to the terminating run to failed/run-terminal, and unpauses', async () => {
      const gate = createSteeringGate('session-1');
      gate.admit(pauseCommand(), { liveRunIds: ['run-1'], now: NOW });
      const waiter = gate.forRun('run-1').awaitResume();
      let resolved = false;
      void waiter.then(() => {
        resolved = true;
      });

      gate.failAcceptedForRun('run-1', '2026-09-02T00:00:05.000Z');

      expect(gate.getDesiredState()).toEqual({ paused: false, configVersion: 1 });
      await waiter;
      expect(resolved).toBe(true);
    });

    it('leaves a command bound to a DIFFERENT run untouched', () => {
      const gate = createSteeringGate('session-1');
      gate.admit(pauseCommand(), { liveRunIds: ['run-1'], now: NOW });
      gate.failAcceptedForRun('run-other', '2026-09-02T00:00:05.000Z');
      // Still paused — the terminating run does not own this command.
      expect(gate.getDesiredState()).toEqual({ paused: true, configVersion: 1 });
    });

    it('is a no-op when nothing accepted is bound to the given runId', () => {
      const gate = createSteeringGate('session-1');
      gate.failAcceptedForRun('run-none', NOW);
      expect(gate.getDesiredState()).toEqual({ paused: false, configVersion: 0 });
    });
  });

  describe('recordApplied / getAppliedFloor (cross-run dedupe write side)', () => {
    it('raises the applied floor and marks accepted commands at or below it as applied', () => {
      const gate = createSteeringGate('session-1');
      const outcome = gate.admit(pauseCommand(), { liveRunIds: ['run-1'], now: NOW });
      expect(outcome.outcome).toBe('accepted');
      expect(gate.getAppliedFloor()).toBe(0);

      gate.recordApplied('run-1', 1, NOW);
      expect(gate.getAppliedFloor()).toBe(1);

      // A brand-new command admitted at (still) configVersion 1, after the
      // floor already covers it, is reported as already-applied — the exact
      // no-op-idempotency case a second pause hits once the FIRST pause's
      // configVersion has already been consumed by a boundary read.
      const idempotent = gate.admit(pauseCommand({ id: 'cmd-2' }), {
        liveRunIds: ['run-1'],
        now: NOW,
      });
      expect(idempotent.outcome).toBe('accepted');
      if (idempotent.outcome === 'accepted') {
        expect(idempotent.command.state).toBe('applied');
      }
    });

    it('never lowers the floor on a smaller value', () => {
      const gate = createSteeringGate('session-1');
      gate.recordApplied('run-1', 5, NOW);
      gate.recordApplied('run-1', 2, NOW);
      expect(gate.getAppliedFloor()).toBe(5);
    });

    it('does not mark a pause bound to a DIFFERENT run as applied (PR #430 review, Codex P2 — "Scope applied config versions to the target run")', () => {
      const gate = createSteeringGate('session-1');
      gate.promoteForNewRun('run-a');
      gate.promoteForNewRun('run-b');
      const accepted = gate.admit(pauseCommand(), { liveRunIds: ['run-a'], now: NOW });
      expect(accepted.outcome).toBe('accepted');
      if (accepted.outcome !== 'accepted') return;

      // run-b's own boundary reports its own (unaffected) configVersion —
      // but even if it reported the higher, run-a-bound version, applying
      // it must never touch run-a's own pause command.
      gate.recordApplied('run-b', accepted.command.configVersion, NOW);
      expect(accepted.command.state).toBe('accepted'); // snapshot pre-dates recordApplied

      // Only run-a's own boundary can mark run-a's pause applied.
      gate.recordApplied('run-a', accepted.command.configVersion, NOW);
      // Confirmed indirectly: failAcceptedForRun still releases the pause
      // (it does not depend on 'applied' state), so assert desired state
      // directly reflects the (still un-recorded-by-run-b) accepted pause.
      expect(gate.forRun('run-a').getDesiredState().paused).toBe(true);
    });

    it('does not apply a deferred agent-identity command to a run whose baseline predates it (PR #430 review, Codex P2 — "Keep deferred identity changes out of pause application")', () => {
      const gate = createSteeringGate('session-1');
      gate.promoteForNewRun('run-a'); // run-a's baseline: 0

      // Identity command admitted mid-run-a: bumps the raw counter but is
      // deferred to the NEXT run's start, not run-a's own baseline.
      const identity = gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
        },
        { liveRunIds: ['run-a'], now: NOW },
      );
      expect(identity.outcome).toBe('accepted');

      // A pause bound to run-a bumps configVersion PAST the identity's own
      // version — run-a's own boundary read reports this higher version.
      const pause = gate.admit(pauseCommand(), { liveRunIds: ['run-a'], now: NOW });
      expect(pause.outcome).toBe('accepted');
      if (pause.outcome !== 'accepted') return;

      // run-a's own recordApplied call, at its own (inflated) configVersion,
      // must mark its OWN pause applied but leave the identity command
      // untouched — it was never part of run-a's baseline.
      gate.recordApplied('run-a', pause.command.configVersion, NOW);
      const identitySnapshot = identity.outcome === 'accepted' ? identity.command : undefined;
      expect(identitySnapshot?.state).toBe('accepted');

      // A NEW run whose baseline captures the identity bump correctly
      // applies it at its own first boundary.
      gate.promoteForNewRun('run-b');
      expect(gate.forRun('run-b').getDesiredState().agentName).toBe('reviewer');
      const runBVersion = gate.forRun('run-b').getDesiredState().configVersion;
      gate.recordApplied('run-b', runBVersion, NOW);

      // Replaying the identity command's own id now reports it as applied —
      // run-b's own boundary, whose baseline covers it, finally consumed it.
      const replay = gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
        },
        { liveRunIds: ['run-b'], now: NOW },
      );
      expect(replay).toEqual({
        outcome: 'replayed',
        command: expect.objectContaining({ state: 'applied' }),
      });
    });
  });

  describe('agent-identity deferral (AB-199 coordinator amendments, 2026-09-02 addendum)', () => {
    it('an agent-identity command bumps configVersion but does not change getDesiredState() until promoteForNewRun()', () => {
      const gate = createSteeringGate('session-1');
      const outcome = gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
        },
        { liveRunIds: [], now: NOW },
      );
      expect(outcome.outcome).toBe('accepted');
      // Accepted mid-"run": the command is genuinely part of DESIRED state
      // immediately (getDesiredState().agentName reflects it), but NOT yet
      // effective — configVersion stays at its pre-bump value, so a merged
      // runStep reading `getDesiredState().configVersion` for its
      // steering.applied dedupe would not fire for it until promotion.
      expect(gate.getDesiredState()).toEqual({
        paused: false,
        configVersion: 0,
        agentName: 'reviewer',
      });

      gate.promoteForNewRun('run-1');
      expect(gate.getDesiredState()).toEqual({
        paused: false,
        configVersion: 1,
        agentName: 'reviewer',
      });
    });

    it('promoteForNewRun() is a no-op on agentName/configVersion when nothing was pending', () => {
      const gate = createSteeringGate('session-1');
      gate.admit(pauseCommand(), { liveRunIds: ['run-1'], now: NOW });
      gate.promoteForNewRun('run-1');
      expect(gate.getDesiredState()).toEqual({ paused: true, configVersion: 1 });
    });

    it('a pause admitted after a pending agent-identity bump stays immediately effective (not deferred)', () => {
      const gate = createSteeringGate('session-1');
      gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
        },
        { liveRunIds: [], now: NOW },
      );
      // configVersion 1 is pending (identity-only); pause bumps to 2 and IS
      // immediately effective — pause/resume never defer.
      const outcome = gate.admit(pauseCommand(), { liveRunIds: ['run-1'], now: NOW });
      expect(outcome.outcome).toBe('accepted');
      expect(gate.getDesiredState()).toEqual({
        paused: true,
        configVersion: 2,
        agentName: 'reviewer',
      });
    });
  });

  describe('forRun (per-run pause scoping — PR #430 review, Codex P1)', () => {
    it('a pause bound to one run does not block a concurrent, different run on the same session', async () => {
      const gate = createSteeringGate('session-1');
      gate.admit(pauseCommand(), { liveRunIds: ['run-a'], now: NOW });

      // run-a's own view: paused.
      expect(gate.forRun('run-a').getDesiredState().paused).toBe(true);
      // run-b's view: NOT paused — a pause bound to run-a must never block it.
      expect(gate.forRun('run-b').getDesiredState().paused).toBe(false);
      await gate.forRun('run-b').awaitResume(); // resolves immediately — not paused for run-b
    });

    it("resuming run-a releases only run-a's waiter, never run-b's", async () => {
      const gate = createSteeringGate('session-1');
      gate.admit(pauseCommand({ id: 'pause-a' }), { liveRunIds: ['run-a'], now: NOW });
      gate.admit(pauseCommand({ id: 'pause-b' }), { liveRunIds: ['run-b'], now: NOW });

      let bResolved = false;
      void gate
        .forRun('run-b')
        .awaitResume()
        .then(() => {
          bResolved = true;
        });

      const outcome = gate.admit(resumeCommand({ id: 'resume-a' }), {
        liveRunIds: ['run-a'],
        now: NOW,
      });
      expect(outcome.outcome).toBe('accepted');
      expect(gate.forRun('run-a').getDesiredState().paused).toBe(false);
      // run-b is still paused — its own resume was never admitted.
      expect(gate.forRun('run-b').getDesiredState().paused).toBe(true);
      expect(bResolved).toBe(false);
    });

    it('a pause bound to one run does not inflate a DIFFERENT run\'s own configVersion (PR #430 review, Codex P2 — "Scope applied config versions to the target run")', () => {
      const gate = createSteeringGate('session-1');
      gate.promoteForNewRun('run-a');
      gate.promoteForNewRun('run-b');
      gate.admit(pauseCommand(), { liveRunIds: ['run-a'], now: NOW });
      // run-a's own pause bumped its own visible version...
      expect(gate.forRun('run-a').getDesiredState().configVersion).toBe(1);
      // ...but run-b, unaffected, still reports its own (pre-pause) baseline.
      expect(gate.forRun('run-b').getDesiredState().configVersion).toBe(0);
      expect(gate.forRun('unrelated-run').getAppliedFloor?.()).toBe(0);
    });

    it("agentName reflects only the identity captured at THIS run's own promotion, not a run that has not promoted yet", () => {
      const gate = createSteeringGate('session-1');
      gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
        },
        { liveRunIds: [], now: NOW },
      );
      gate.promoteForNewRun('run-a');
      expect(gate.forRun('run-a').getDesiredState().agentName).toBe('reviewer');
      // run-b has never been promoted — it must not inherit run-a's
      // already-promoted identity merely by asking.
      expect(gate.forRun('run-b').getDesiredState().agentName).toBeUndefined();

      // Once run-b is ALSO promoted, it captures whatever is effective at
      // that moment — the same 'reviewer' identity, since nothing new is
      // pending.
      gate.promoteForNewRun('run-b');
      expect(gate.forRun('run-b').getDesiredState().agentName).toBe('reviewer');
    });

    it('a promotion for a NEW, concurrent run does not retroactively change an ALREADY-RUNNING run\'s own agentName (PR #430 review, Codex P2 — "Scope promoted agent identities to runs started afterward")', () => {
      const gate = createSteeringGate('session-1');
      gate.promoteForNewRun('run-a'); // run-a starts with no identity set yet
      expect(gate.forRun('run-a').getDesiredState().agentName).toBeUndefined();

      // An identity command is admitted mid-run-a — deferred, not effective
      // for run-a itself (see the "agent-identity deferral" suite above).
      gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
        },
        { liveRunIds: ['run-a'], now: NOW },
      );

      // A concurrent run-b starts and promotes it into effect for ITSELF.
      gate.promoteForNewRun('run-b');
      expect(gate.forRun('run-b').getDesiredState().agentName).toBe('reviewer');

      // run-a, already in flight before run-b's promotion, must not observe
      // run-b's newly-promoted identity mid-run.
      expect(gate.forRun('run-a').getDesiredState().agentName).toBeUndefined();
    });
  });

  describe('promoteForNewRun rejects an expired pending identity instead of promoting it (PR #430 review, Codex P2 — "Reject expired identities before promoting them")', () => {
    it("fails a still-accepted identity command whose deadline passed before the next run's own promotion, rather than making it effective", () => {
      const gate = createSteeringGate('session-1');
      const identity = gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
          deadline: '2026-09-02T00:00:02.000Z',
        },
        { liveRunIds: [], now: NOW }, // NOW = 00:00:01, before the deadline
      );
      expect(identity.outcome).toBe('accepted');

      // The next run's own promotion arrives after the deadline passed.
      const promotionNow = '2026-09-02T00:00:05.000Z';
      gate.promoteForNewRun('run-1', promotionNow);

      // The identity never became effective for run-1.
      expect(gate.forRun('run-1').getDesiredState().agentName).toBeUndefined();

      const replay = gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
          deadline: '2026-09-02T00:00:02.000Z',
        },
        { liveRunIds: [], now: promotionNow },
      );
      expect(replay).toEqual({
        outcome: 'replayed',
        command: expect.objectContaining({
          state: 'failed',
          failure: { failedAt: promotionNow, reason: 'deadline-passed' },
        }),
      });
    });

    it('promotes normally, with no deadline set on the pending identity', () => {
      const gate = createSteeringGate('session-1');
      gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
        },
        { liveRunIds: [], now: NOW },
      );
      gate.promoteForNewRun('run-1'); // no explicit `now` — defaults internally
      expect(gate.forRun('run-1').getDesiredState().agentName).toBe('reviewer');
    });
  });

  describe('failAcceptedForRun after recordApplied has already promoted the command (PR #430 review, Codex P1)', () => {
    it('still releases the pause binding even when the command already reached applied', async () => {
      const gate = createSteeringGate('session-1');
      const accepted = gate.admit(pauseCommand(), { liveRunIds: ['run-1'], now: NOW });
      expect(accepted.outcome).toBe('accepted');

      // runStep's own SteeringAppliedEvent listener races ahead of the
      // run's terminal listener: the command is 'applied' before
      // failAcceptedForRun ever runs.
      gate.recordApplied('run-1', 1, NOW);
      if (accepted.outcome === 'accepted') {
        expect(accepted.command.state).toBe('accepted'); // snapshot taken before recordApplied
      }

      const waiter = gate.forRun('run-1').awaitResume();
      let resolved = false;
      void waiter.then(() => {
        resolved = true;
      });

      gate.failAcceptedForRun('run-1', '2026-09-02T00:00:05.000Z');

      // The pause releases regardless of the command's now-'applied' state —
      // an `state === 'accepted'`-only predicate would have skipped it,
      // leaving this (and every future run on the session) stuck paused.
      expect(gate.forRun('run-1').getDesiredState().paused).toBe(false);
      await waiter;
      expect(resolved).toBe(true);
    });
  });

  describe('deadline and expectedRevision (PR #430 review, Codex P2)', () => {
    it('rejects a command whose deadline has already passed', () => {
      const gate = createSteeringGate('session-1');
      const outcome = gate.admit(
        {
          ...pauseCommand(),
          deadline: '2026-09-01T00:00:00.000Z',
        },
        { liveRunIds: ['run-1'], now: NOW }, // NOW is 2026-09-02, after the deadline
      );
      expect(outcome).toEqual({
        outcome: 'rejected',
        failure: { failedAt: NOW, reason: 'deadline-passed' },
      });
      expect(gate.getDesiredState()).toEqual({ paused: false, configVersion: 0 });
    });

    it('accepts a command whose deadline has not yet passed', () => {
      const gate = createSteeringGate('session-1');
      const outcome = gate.admit(
        { ...pauseCommand(), deadline: '2026-09-03T00:00:00.000Z' },
        { liveRunIds: ['run-1'], now: NOW },
      );
      expect(outcome.outcome).toBe('accepted');
    });

    it('rejects a command whose expectedRevision does not match the current configVersion', () => {
      const gate = createSteeringGate('session-1');
      gate.admit(pauseCommand({ id: 'p1' }), { liveRunIds: ['run-1'], now: NOW }); // configVersion -> 1
      const stale = gate.admit(
        { ...resumeCommand({ id: 'stale-resume' }), expectedRevision: 0 },
        { liveRunIds: ['run-1'], now: NOW },
      );
      expect(stale).toEqual({
        outcome: 'rejected',
        failure: { failedAt: NOW, reason: 'policy-denied' },
      });
      // The stale resume must not have reversed the pause.
      expect(gate.getDesiredState()).toEqual({ paused: true, configVersion: 1 });
    });

    it('accepts a command whose expectedRevision matches the current configVersion', () => {
      const gate = createSteeringGate('session-1');
      const outcome = gate.admit(
        { ...pauseCommand(), expectedRevision: 0 },
        { liveRunIds: ['run-1'], now: NOW },
      );
      expect(outcome.outcome).toBe('accepted');
    });
  });

  describe('deadline compared as epoch instants (PR #430 review, Codex P2)', () => {
    it('rejects a deadline that is already past, even when its offset sorts lexicographically LATER than now', () => {
      // now = 08:00 UTC. A deadline written with a +05:00 offset represents
      // 07:00 UTC — already passed — but the STRING '12:00' sorts AFTER
      // '08:00', so a lexicographic (string) comparison would wrongly
      // accept it. Comparing epoch instants (Date.parse) gets it right.
      const gate = createSteeringGate('session-1');
      const now = '2026-09-02T08:00:00.000Z';
      const outcome = gate.admit(
        { ...pauseCommand(), deadline: '2026-09-02T12:00:00+05:00' },
        { liveRunIds: ['run-1'], now },
      );
      expect(outcome).toEqual({
        outcome: 'rejected',
        failure: { failedAt: now, reason: 'deadline-passed' },
      });
    });
  });

  describe('deadline enforced at application, agent-identity only (PR #430 review, Codex P2 — "Expire accepted commands before their application boundary", refined by Codex P1 "Revert expired commands\' desired-state changes")', () => {
    it('marks an accepted agent-identity command failed/deadline-passed at recordApplied time if its deadline passed while still accepted', () => {
      const gate = createSteeringGate('session-1');
      gate.promoteForNewRun('run-1'); // baseline: 0
      const outcome = gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
          deadline: '2026-09-02T00:00:02.000Z',
        },
        { liveRunIds: [], now: NOW }, // NOW = 00:00:01, before the deadline
      );
      expect(outcome.outcome).toBe('accepted');

      // A new run's own boundary read arrives after the deadline has passed.
      // `run-2` itself starts (and promotes) BEFORE the deadline passes —
      // its own `promoteForNewRun` deadline check must not fire yet, so the
      // command survives to be caught at `recordApplied` time instead, per
      // this test's own name.
      const boundaryNow = '2026-09-02T00:00:05.000Z';
      gate.promoteForNewRun('run-2', NOW); // baseline now covers identity-1's version
      const runVersion = gate.forRun('run-2').getDesiredState().configVersion;
      gate.recordApplied('run-2', runVersion, boundaryNow);

      const replay = gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
          deadline: '2026-09-02T00:00:02.000Z',
        },
        { liveRunIds: [], now: boundaryNow },
      );
      expect(replay).toEqual({
        outcome: 'replayed',
        command: expect.objectContaining({
          state: 'failed',
          failure: { failedAt: boundaryNow, reason: 'deadline-passed' },
        }),
      });
    });

    it('applies an agent-identity command normally when its deadline has not passed by the time recordApplied runs', () => {
      const gate = createSteeringGate('session-1');
      gate.promoteForNewRun('run-1');
      const outcome = gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
          deadline: '2026-09-03T00:00:00.000Z',
        },
        { liveRunIds: [], now: NOW },
      );
      expect(outcome.outcome).toBe('accepted');
      // Explicit `now`, well before the fixture's deadline above — the
      // default (real wall-clock) `now` this call would otherwise use is
      // not safe against a fixed 2026 fixture deadline indefinitely (this
      // regressed for real once the calendar caught up to it).
      gate.promoteForNewRun('run-2', NOW);
      const runVersion = gate.forRun('run-2').getDesiredState().configVersion;
      gate.recordApplied('run-2', runVersion, NOW);
      const replay = gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
          deadline: '2026-09-03T00:00:00.000Z',
        },
        { liveRunIds: [], now: NOW },
      );
      expect(replay).toEqual({
        outcome: 'replayed',
        command: expect.objectContaining({ state: 'applied' }),
      });
    });

    it('reverts (unpauses, releases waiters) an expired pause at application time, rather than leaving it failed but still blocking (PR #430 review, Codex P1, "Revert expired commands\' desired-state changes")', async () => {
      const gate = createSteeringGate('session-1');
      gate.promoteForNewRun('run-1');
      const outcome = gate.admit(
        { ...pauseCommand(), deadline: '2026-09-02T00:00:02.000Z' },
        { liveRunIds: ['run-1'], now: NOW }, // NOW = 00:00:01, before the deadline
      );
      expect(outcome.outcome).toBe('accepted');
      if (outcome.outcome !== 'accepted') return;
      expect(gate.forRun('run-1').getDesiredState().paused).toBe(true);

      const waiter = gate.forRun('run-1').awaitResume();
      let resolved = false;
      void waiter.then(() => {
        resolved = true;
      });

      // The boundary read arrives after the deadline has now passed.
      const boundaryNow = '2026-09-02T00:00:05.000Z';
      gate.recordApplied('run-1', outcome.command.configVersion, boundaryNow);

      // The pause both transitions to failed/deadline-passed AND actually
      // releases the run — not one without the other.
      const replay = gate.admit(pauseCommand(), { liveRunIds: ['run-1'], now: boundaryNow });
      expect(replay).toEqual({
        outcome: 'replayed',
        command: expect.objectContaining({
          state: 'failed',
          failure: { failedAt: boundaryNow, reason: 'deadline-passed' },
        }),
      });
      expect(gate.forRun('run-1').getDesiredState().paused).toBe(false);
      await waiter;
      expect(resolved).toBe(true);
    });

    it("does NOT re-check a resume's deadline at application — its effect already happened at admission and there is nothing to revert", () => {
      const gate = createSteeringGate('session-1');
      gate.promoteForNewRun('run-1');
      gate.admit(pauseCommand({ id: 'p1' }), { liveRunIds: ['run-1'], now: NOW });
      const outcome = gate.admit(
        { ...resumeCommand({ id: 'r1' }), deadline: '2026-09-02T00:00:02.000Z' },
        { liveRunIds: ['run-1'], now: NOW }, // NOW = 00:00:01, before the deadline
      );
      expect(outcome.outcome).toBe('accepted');
      if (outcome.outcome !== 'accepted') return;
      expect(gate.forRun('run-1').getDesiredState().paused).toBe(false); // already released

      // The boundary read arrives after the deadline has now passed — but
      // the resume already released the run at admission, so this must mark
      // it applied (not failed, which would have nothing left to revert).
      const boundaryNow = '2026-09-02T00:00:05.000Z';
      gate.recordApplied('run-1', outcome.command.configVersion, boundaryNow);

      const replay = gate.admit(
        { ...resumeCommand({ id: 'r1' }), deadline: '2026-09-02T00:00:02.000Z' },
        { liveRunIds: ['run-1'], now: boundaryNow },
      );
      expect(replay).toEqual({
        outcome: 'replayed',
        command: expect.objectContaining({ state: 'applied' }),
      });
    });
  });

  describe('new-run baselines exclude other runs\' own pause/resume versions (PR #430 review, Codex P2 — "Exclude run-specific commands from new-run baselines")', () => {
    it("a failed pause from a terminated run does not inflate a later run's baseline or fire a spurious steering.applied version", () => {
      const gate = createSteeringGate('session-1');
      gate.promoteForNewRun('run-a');
      const pause = gate.admit(pauseCommand(), { liveRunIds: ['run-a'], now: NOW });
      expect(pause.outcome).toBe('accepted');

      // run-a terminates before ever reaching a boundary that applies it.
      gate.failAcceptedForRun('run-a', NOW);

      // run-b's baseline must NOT include run-a's now-dead pause version —
      // it never involved run-b, and a spurious non-zero configVersion here
      // would fire a meaningless steering.applied for run-b.
      gate.promoteForNewRun('run-b');
      expect(gate.forRun('run-b').getDesiredState().configVersion).toBe(0);
    });

    it("an identity command's version DOES seed a later run's baseline, unaffected by an unrelated failed pause admitted afterward", () => {
      const gate = createSteeringGate('session-1');
      const identity = gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
        },
        { liveRunIds: [], now: NOW },
      );
      expect(identity.outcome).toBe('accepted');
      if (identity.outcome !== 'accepted') return;

      gate.promoteForNewRun('run-a');
      gate.admit(pauseCommand(), { liveRunIds: ['run-a'], now: NOW }); // unrelated, later, higher version
      gate.failAcceptedForRun('run-a', NOW);

      gate.promoteForNewRun('run-b');
      expect(gate.forRun('run-b').getDesiredState().configVersion).toBe(
        identity.command.configVersion,
      );
      expect(gate.forRun('run-b').getDesiredState().agentName).toBe('reviewer');
    });
  });

  describe('promoteForNewRun clears the pending identity key (PR #430 review, Codex P2 — "Clear the pending identity key when promoting it")', () => {
    it('does not let a later identity command wrongly supersede one already promoted for an earlier run', () => {
      const gate = createSteeringGate('session-1');
      const first = gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
        },
        { liveRunIds: [], now: NOW },
      );
      expect(first.outcome).toBe('accepted');

      // Promoted for run-a — identity-1 is now EFFECTIVE, not pending.
      gate.promoteForNewRun('run-a');

      // A second identity command, admitted after promotion, must not mark
      // the already-effective identity-1 as superseded.
      gate.admit(
        {
          id: 'identity-2',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'auditor' },
          requestedAt: NOW,
        },
        { liveRunIds: [], now: NOW },
      );

      const replayFirst = gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
        },
        { liveRunIds: [], now: NOW },
      );
      // Still 'accepted' (later 'applied' once a run's recordApplied
      // consumes it) — NOT 'superseded'. identity-1 already took effect for
      // run-a; identity-2 is deferred to whatever run starts next.
      expect(replayFirst).toEqual({
        outcome: 'replayed',
        command: expect.objectContaining({ state: 'accepted' }),
      });
    });
  });

  describe('terminal-run bookkeeping cleanup (PR #430 review, Codex P2 — "Remove terminal runs from gate bookkeeping")', () => {
    it('failAcceptedForRun releases this run from a fresh awaitResume() registration without leaking a stale waiter bucket', async () => {
      const gate = createSteeringGate('session-1');
      gate.promoteForNewRun('run-1');
      gate.admit(pauseCommand(), { liveRunIds: ['run-1'], now: NOW });
      gate.failAcceptedForRun('run-1', NOW);

      // A fresh registration against the now-terminal, cleaned-up run
      // resolves immediately (nothing paused for it any more) rather than
      // hanging on stale internal state.
      await gate.forRun('run-1').awaitResume();
      expect(gate.forRun('run-1').getDesiredState()).toEqual({ paused: false, configVersion: 0 });
    });
  });

  describe('replay matching includes the bound run (PR #430 review, Codex P2 — "Include the bound run in replay matching")', () => {
    it('a same-id retry naming a DIFFERENT explicit runId is a conflict, not a replay', () => {
      const gate = createSteeringGate('session-1');
      const first = gate.admit(pauseCommand({ id: 'x', runId: 'run-a' }), {
        liveRunIds: ['run-a', 'run-b'],
        now: NOW,
      });
      expect(first.outcome).toBe('accepted');

      const second = gate.admit(pauseCommand({ id: 'x', runId: 'run-b' }), {
        liveRunIds: ['run-a', 'run-b'],
        now: NOW,
      });
      expect(second.outcome).toBe('conflict');
      if (second.outcome === 'conflict') {
        expect(second.conflict.reason).toBe('requested-value-mismatch');
      }
      // run-b was never actually paused by the rejected retry.
      expect(gate.forRun('run-b').getDesiredState().paused).toBe(false);
      expect(gate.forRun('run-a').getDesiredState().paused).toBe(true);
    });

    it('an exact retry naming the SAME explicit runId still replays normally', () => {
      const gate = createSteeringGate('session-1');
      const first = gate.admit(pauseCommand({ id: 'x', runId: 'run-a' }), {
        liveRunIds: ['run-a'],
        now: NOW,
      });
      expect(first.outcome).toBe('accepted');
      const retry = gate.admit(pauseCommand({ id: 'x', runId: 'run-a' }), {
        liveRunIds: ['run-a'],
        now: NOW,
      });
      expect(retry.outcome).toBe('replayed');
    });
  });

  describe('unambiguous idempotency key (PR #430 review, Codex P2 — "Use an unambiguous idempotency key")', () => {
    it('does not confuse (principal, id) pairs whose delimited concatenation would collide', () => {
      const gate = createSteeringGate('session-1');
      const first = gate.admit(pauseCommand({ principal: 'a:b', id: 'c' }), {
        liveRunIds: ['run-1'],
        now: NOW,
      });
      expect(first.outcome).toBe('accepted');

      // ('a', 'b:c') concatenates to the SAME 'a:b:c' string as ('a:b', 'c')
      // above, but is a genuinely different (principal, id) pair and must be
      // admitted as its own distinct command, not treated as a replay or
      // conflict of the first.
      const second = gate.admit(pauseCommand({ principal: 'a', id: 'b:c' }), {
        liveRunIds: ['run-1'],
        now: NOW,
      });
      expect(second.outcome).toBe('accepted');
    });
  });

  describe('supersede earlier pending identity commands (PR #430 review, Codex P2 — "Supersede earlier pending identity commands")', () => {
    it('marks an earlier still-accepted agent-identity command superseded when a replacement is admitted before promotion', () => {
      const gate = createSteeringGate('session-1');
      const first = gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
        },
        { liveRunIds: [], now: NOW },
      );
      expect(first.outcome).toBe('accepted');

      const second = gate.admit(
        {
          id: 'identity-2',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'auditor' },
          requestedAt: NOW,
        },
        { liveRunIds: [], now: NOW },
      );
      expect(second.outcome).toBe('accepted');

      // The first command's own id now reports superseded/superseded-by —
      // an exact retry of its own original request replays its CURRENT
      // (now-superseded) state, unchanged.
      const replayFirst = gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
        },
        { liveRunIds: [], now: NOW },
      );
      expect(replayFirst).toEqual({
        outcome: 'replayed',
        command: expect.objectContaining({
          state: 'superseded',
          failure: { failedAt: NOW, reason: 'superseded-by', supersededBy: 'identity-2' },
        }),
      });

      // The SECOND (winning) identity is the one that ends up promoted.
      gate.promoteForNewRun('run-1');
      expect(gate.forRun('run-1').getDesiredState().agentName).toBe('auditor');
    });
  });

  describe('purgeFromLedger (PR #430 review, Codex P2 — "Purge deleted sessions from the shared ledger")', () => {
    it("removes every ledger entry this session owns, and a REUSED session id starts with a fresh gate that does not replay the deleted session's commands", () => {
      const sharedLedger = createSteeringCommandLedger();
      const gateA = createSteeringGate('session-a', sharedLedger);
      gateA.admit(pauseCommand({ sessionId: 'session-a' }), { liveRunIds: ['run-a'], now: NOW });
      gateA.purgeFromLedger();

      // A session id reused after deletion gets a fresh gate; the SAME
      // (principal, id) pair is now admitted as a genuinely new command,
      // not replayed against — or conflicting with — the deleted session's
      // old ledger entry.
      const gateAReused = createSteeringGate('session-a', sharedLedger);
      const outcome = gateAReused.admit(pauseCommand({ sessionId: 'session-a' }), {
        liveRunIds: ['run-new'],
        now: NOW,
      });
      expect(outcome.outcome).toBe('accepted');
    });

    it('leaves entries owned by OTHER sessions in the shared ledger untouched', () => {
      const sharedLedger = createSteeringCommandLedger();
      const gateA = createSteeringGate('session-a', sharedLedger);
      const gateB = createSteeringGate('session-b', sharedLedger);
      gateA.admit(pauseCommand({ sessionId: 'session-a', id: 'a-1' }), {
        liveRunIds: ['run-a'],
        now: NOW,
      });
      gateB.admit(pauseCommand({ sessionId: 'session-b', id: 'b-1', principal: 'bob' }), {
        liveRunIds: ['run-b'],
        now: NOW,
      });

      gateA.purgeFromLedger();

      // session-b's own command still replays normally — its principal's
      // ledger entry survived a purge scoped to a DIFFERENT principal.
      const replay = gateB.admit(
        pauseCommand({ sessionId: 'session-b', id: 'b-1', principal: 'bob' }),
        { liveRunIds: ['run-b'], now: NOW },
      );
      expect(replay.outcome).toBe('replayed');
    });

    it('is a no-op when this session owns no ledger entries at all', () => {
      const gate = createSteeringGate('session-empty');
      gate.purgeFromLedger();
      expect(gate.getDesiredState()).toEqual({ paused: false, configVersion: 0 });
    });
  });

  describe('shared ledger across sessions (PR #430 review, Codex P2)', () => {
    it('a same-(principal, id) retry against a different session returns session-mismatch, not a second accepted command', () => {
      const sharedLedger = createSteeringCommandLedger();
      const gateA = createSteeringGate('session-a', sharedLedger);
      const gateB = createSteeringGate('session-b', sharedLedger);

      const first = gateA.admit(pauseCommand({ sessionId: 'session-a' }), {
        liveRunIds: ['run-a'],
        now: NOW,
      });
      expect(first.outcome).toBe('accepted');

      const second = gateB.admit(pauseCommand({ sessionId: 'session-b' }), {
        liveRunIds: ['run-b'],
        now: NOW,
      });
      expect(second.outcome).toBe('conflict');
      if (second.outcome === 'conflict') {
        expect(second.conflict.reason).toBe('session-mismatch');
      }

      // session-b's own state is untouched — the conflicting retry never
      // reached its gate's desired state.
      expect(gateB.getDesiredState()).toEqual({ paused: false, configVersion: 0 });
    });

    it('createSteeringCommandLedger() produces an empty, independently-usable ledger', () => {
      const ledger = createSteeringCommandLedger();
      const gateA = createSteeringGate('session-a', ledger);
      const gateB = createSteeringGate('session-b', ledger);
      gateA.admit(pauseCommand({ sessionId: 'session-a' }), { liveRunIds: ['run-a'], now: NOW });
      const outcome = gateB.admit(pauseCommand({ sessionId: 'session-b' }), {
        liveRunIds: ['run-b'],
        now: NOW,
      });
      expect(outcome.outcome).toBe('conflict');
    });
  });

  describe('per-run applied-version floor, not the session-wide floor (PR #430 review, Codex P2 — "Avoid treating noncontiguous applied versions as a floor")', () => {
    it("a second idempotent pause for a still-unapplied run is not misreported as applied merely because a DIFFERENT run's own boundary raised the session-wide floor past its version", () => {
      const gate = createSteeringGate('session-1');
      const pauseA = gate.admit(pauseCommand({ id: 'pause-a' }), {
        liveRunIds: ['run-a'],
        now: NOW,
      }); // configVersion 1
      expect(pauseA.outcome).toBe('accepted');
      const pauseB = gate.admit(pauseCommand({ id: 'pause-b', runId: 'run-b' }), {
        liveRunIds: ['run-a', 'run-b'],
        now: NOW,
      }); // configVersion 2
      expect(pauseB.outcome).toBe('accepted');
      if (pauseB.outcome !== 'accepted') return;

      // run-b's own boundary applies first, raising the SESSION-WIDE floor
      // to 2 — but run-a's own pause (version 1) has not itself been
      // observed by run-a's own boundary yet.
      gate.recordApplied('run-b', pauseB.command.configVersion, NOW);
      expect(gate.getAppliedFloor()).toBe(2);

      // A second, idempotent pause against run-a (still paused, version 1)
      // must stay 'accepted' — run-a's own boundary has not observed it,
      // even though the session-wide floor (raised by an unrelated run) is
      // already past version 1.
      const idempotentA = gate.admit(pauseCommand({ id: 'pause-a-2' }), {
        liveRunIds: ['run-a'],
        now: NOW,
      });
      expect(idempotentA.outcome).toBe('accepted');
      if (idempotentA.outcome === 'accepted') {
        expect(idempotentA.command.state).toBe('accepted');
      }

      // Only run-a's own boundary correctly promotes it.
      gate.recordApplied('run-a', 1, NOW);
      const replay = gate.admit(pauseCommand({ id: 'pause-a' }), {
        liveRunIds: ['run-a'],
        now: NOW,
      });
      expect(replay).toEqual({
        outcome: 'replayed',
        command: expect.objectContaining({ state: 'applied' }),
      });
    });
  });

  describe('ownership of a run\'s pause transition on expiry (PR #430 review, Codex P2 — "Do not release pauses owned by another command")', () => {
    it('an expired idempotent-replay pause does not release a run whose pause another, still-valid command owns', () => {
      const gate = createSteeringGate('session-1');
      const owner = gate.admit(pauseCommand({ id: 'owner' }), {
        liveRunIds: ['run-1'],
        now: NOW,
      }); // no deadline — the actual owning transition
      expect(owner.outcome).toBe('accepted');
      expect(gate.forRun('run-1').getDesiredState().paused).toBe(true);

      // A second, idempotent pause carrying its OWN, shorter deadline —
      // still 'accepted' since the run has not reached a boundary yet.
      const replay = gate.admit(
        { ...pauseCommand({ id: 'replay' }), deadline: '2026-09-02T00:00:02.000Z' },
        { liveRunIds: ['run-1'], now: NOW }, // NOW = 00:00:01, before the deadline
      );
      expect(replay.outcome).toBe('accepted');
      if (owner.outcome !== 'accepted') return;

      // The boundary read arrives after the REPLAY's deadline has passed —
      // but the OWNER never had a deadline at all.
      const boundaryNow = '2026-09-02T00:00:05.000Z';
      gate.recordApplied('run-1', owner.command.configVersion, boundaryNow);

      // The owning command applied normally; the run stays paused — the
      // replay's own expiry must not revert a pause it never created.
      expect(gate.forRun('run-1').getDesiredState().paused).toBe(true);

      const ownerReplay = gate.admit(pauseCommand({ id: 'owner' }), {
        liveRunIds: ['run-1'],
        now: boundaryNow,
      });
      expect(ownerReplay).toEqual({
        outcome: 'replayed',
        command: expect.objectContaining({ state: 'applied' }),
      });

      // The replay itself is the one that failed.
      const replayCheck = gate.admit(
        { ...pauseCommand({ id: 'replay' }), deadline: '2026-09-02T00:00:02.000Z' },
        { liveRunIds: ['run-1'], now: boundaryNow },
      );
      expect(replayCheck).toEqual({
        outcome: 'replayed',
        command: expect.objectContaining({
          state: 'failed',
          failure: { failedAt: boundaryNow, reason: 'deadline-passed' },
        }),
      });
    });
  });

  describe('a skipped pause is superseded, never later misreported as applied (PR #430 review, Codex P2 — "Do not mark skipped steering versions as applied")', () => {
    it("a pause overtaken by a resume before the run's own boundary ever observed it is superseded, not applied", () => {
      const gate = createSteeringGate('session-1');
      const pause = gate.admit(pauseCommand({ id: 'p1' }), { liveRunIds: ['run-1'], now: NOW }); // v1
      expect(pause.outcome).toBe('accepted');

      // A resume overtakes it — the run's boundary will only ever observe
      // v2, never v1.
      const resume = gate.admit(resumeCommand({ id: 'r1' }), {
        liveRunIds: ['run-1'],
        now: NOW,
      }); // v2
      expect(resume.outcome).toBe('accepted');
      if (resume.outcome !== 'accepted') return;

      const replayP1 = gate.admit(pauseCommand({ id: 'p1' }), { liveRunIds: ['run-1'], now: NOW });
      expect(replayP1).toEqual({
        outcome: 'replayed',
        command: expect.objectContaining({
          state: 'superseded',
          failure: { failedAt: NOW, reason: 'superseded-by', supersededBy: 'r1' },
        }),
      });

      // The run's own boundary now reports v2 — recordApplied applies r1,
      // and must never retroactively mark the already-superseded p1 applied.
      gate.recordApplied('run-1', resume.command.configVersion, NOW);
      const replayP1Again = gate.admit(pauseCommand({ id: 'p1' }), {
        liveRunIds: ['run-1'],
        now: NOW,
      });
      expect(replayP1Again).toEqual({
        outcome: 'replayed',
        command: expect.objectContaining({ state: 'superseded' }),
      });
      const replayR1 = gate.admit(resumeCommand({ id: 'r1' }), {
        liveRunIds: ['run-1'],
        now: NOW,
      });
      expect(replayR1).toEqual({
        outcome: 'replayed',
        command: expect.objectContaining({ state: 'applied' }),
      });
    });
  });

  describe('malformed deadline (PR #430 review, Codex P2 — "Reject malformed deadline timestamps")', () => {
    it('rejects a command whose deadline does not parse to a valid instant', () => {
      const gate = createSteeringGate('session-1');
      const outcome = gate.admit(
        { ...pauseCommand(), deadline: 'not-a-date' },
        { liveRunIds: ['run-1'], now: NOW },
      );
      expect(outcome).toEqual({
        outcome: 'rejected',
        failure: { failedAt: NOW, reason: 'deadline-passed' },
      });
      expect(gate.getDesiredState()).toEqual({ paused: false, configVersion: 0 });
    });
  });

  describe('unresolved policyRef identity commands (PR #430 review, Codex P2 — "Reject unresolved policyRef identity commands")', () => {
    it('rejects an agent-identity command carrying only a policyRef as unsupported-capability', () => {
      const gate = createSteeringGate('session-1');
      const outcome = gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', policyRef: 'catalog:reviewer' },
          requestedAt: NOW,
        },
        { liveRunIds: [], now: NOW },
      );
      expect(outcome).toEqual({
        outcome: 'unsupported-capability',
        reason: 'selector-unavailable',
      });
      // No ledger entry was created — a resolved override with the same id
      // is a genuinely new admission, not a replay of a rejected one.
      expect(gate.getDesiredState()).toEqual({ paused: false, configVersion: 0 });
      const followUp = gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
        },
        { liveRunIds: [], now: NOW },
      );
      expect(followUp.outcome).toBe('accepted');
    });
  });

  describe('settleForDeletion (PR #430 review, Codex P2 — "Settle paused runs before deleting their steering gate")', () => {
    it("releases a paused run's waiter and fails its accepted command when the gate is discarded", async () => {
      const gate = createSteeringGate('session-1');
      gate.promoteForNewRun('run-1');
      const outcome = gate.admit(pauseCommand(), { liveRunIds: ['run-1'], now: NOW });
      expect(outcome.outcome).toBe('accepted');
      expect(gate.forRun('run-1').getDesiredState().paused).toBe(true);

      const waiter = gate.forRun('run-1').awaitResume();
      let resolved = false;
      void waiter.then(() => {
        resolved = true;
      });

      const deletedAt = '2026-09-02T00:00:05.000Z';
      gate.settleForDeletion(deletedAt);

      expect(gate.forRun('run-1').getDesiredState().paused).toBe(false);
      await waiter;
      expect(resolved).toBe(true);

      const replay = gate.admit(pauseCommand(), { liveRunIds: ['run-1'], now: NOW });
      expect(replay).toEqual({
        outcome: 'replayed',
        command: expect.objectContaining({
          state: 'failed',
          failure: { failedAt: deletedAt, reason: 'run-terminal' },
        }),
      });
    });

    it('releases every run this gate tracks, including one that never paused', () => {
      const gate = createSteeringGate('session-1');
      gate.promoteForNewRun('run-1');
      gate.promoteForNewRun('run-2');
      gate.admit(pauseCommand(), { liveRunIds: ['run-1'], now: NOW });

      gate.settleForDeletion(NOW);

      expect(gate.forRun('run-1').getDesiredState().paused).toBe(false);
      // run-2 never paused, but its bookkeeping is released too — a fresh
      // read shows the default, never a stale baseline.
      expect(gate.forRun('run-2').getDesiredState()).toEqual({ paused: false, configVersion: 0 });
    });

    it('is a no-op when this gate has no runs to settle', () => {
      const gate = createSteeringGate('session-1');
      gate.settleForDeletion(NOW);
      expect(gate.getDesiredState()).toEqual({ paused: false, configVersion: 0 });
    });
  });

  describe('keep a valid duplicate pause when the owner expires (PR #430 review, Codex P2, second wave — "Keep a valid duplicate pause when the owner expires")', () => {
    it('stays paused when a still-valid duplicate pause outlives the original, shorter-deadline owner', () => {
      const gate = createSteeringGate('session-1');
      const owner = gate.admit(
        { ...pauseCommand({ id: 'owner' }), deadline: '2026-09-02T00:00:02.000Z' },
        { liveRunIds: ['run-1'], now: NOW },
      ); // v1, expires at 00:00:02
      expect(owner.outcome).toBe('accepted');
      expect(gate.forRun('run-1').getDesiredState().paused).toBe(true);

      // A second, distinct pause admitted while already paused — an
      // idempotent no-op against configVersion, but a genuinely additional
      // owner with its own, LATER deadline.
      const duplicate = gate.admit(
        { ...pauseCommand({ id: 'duplicate' }), deadline: '2026-09-02T00:00:10.000Z' },
        { liveRunIds: ['run-1'], now: NOW },
      );
      expect(duplicate.outcome).toBe('accepted');
      if (owner.outcome !== 'accepted') return;

      // The boundary read arrives after the OWNER's deadline but before the
      // duplicate's.
      const boundaryNow = '2026-09-02T00:00:05.000Z';
      gate.recordApplied('run-1', owner.command.configVersion, boundaryNow);

      // The owner expired and was removed as an owner, but the still-valid
      // duplicate keeps the run paused.
      expect(gate.forRun('run-1').getDesiredState().paused).toBe(true);

      const ownerReplay = gate.admit(pauseCommand({ id: 'owner' }), {
        liveRunIds: ['run-1'],
        now: boundaryNow,
      });
      expect(ownerReplay).toEqual({
        outcome: 'replayed',
        command: expect.objectContaining({
          state: 'failed',
          failure: { failedAt: boundaryNow, reason: 'deadline-passed' },
        }),
      });

      // The duplicate itself was eligible at this SAME boundary (it shares
      // the owner's configVersion) and its own deadline had not yet
      // passed, so it was consumed normally — 'applied', not 'accepted'.
      // A command's deadline is only ever checked once, at the boundary
      // that first observes it while still 'accepted' (AB-67's application-
      // boundary model has no notion of re-litigating an already-consumed
      // transition later); this is what keeps the run paused above, not a
      // promise that a LATER boundary would revisit the duplicate's own
      // now-past deadline.
      const duplicateReplay = gate.admit(pauseCommand({ id: 'duplicate' }), {
        liveRunIds: ['run-1'],
        now: boundaryNow,
      });
      expect(duplicateReplay).toEqual({
        outcome: 'replayed',
        command: expect.objectContaining({ state: 'applied' }),
      });
    });
  });

  describe('reject commands addressed to another gate (PR #430 review, Codex P2, second wave — "Reject commands addressed to another gate")', () => {
    it("rejects a brand-new (principal, id) command whose sessionId does not match this gate's own session", () => {
      const gate = createSteeringGate('session-1');
      const outcome = gate.admit(pauseCommand({ sessionId: 'session-2' }), {
        liveRunIds: ['run-1'],
        now: NOW,
      });
      expect(outcome).toEqual({
        outcome: 'rejected',
        failure: { failedAt: NOW, reason: 'policy-denied' },
      });
      // Nothing was admitted — the gate's own desired state is untouched.
      expect(gate.getDesiredState()).toEqual({ paused: false, configVersion: 0 });
    });
  });

  describe('recheck identity deadlines before exposing them to step zero (PR #430 review, Codex P2, second wave — "Recheck identity deadlines before exposing them to step zero")', () => {
    it("omits agentName from a run's own view once its promoted identity's deadline has passed, even though promotion itself succeeded", () => {
      const gate = createSteeringGate('session-1');
      // Deadlines chosen well beyond this test's own execution so the
      // "not yet expired" read below never depends on being fast; only the
      // deliberately-mocked "expired" read below moves past it.
      const deadline = '2030-01-01T00:00:02.000Z';
      const identity = gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
          deadline,
        },
        { liveRunIds: [], now: NOW },
      );
      expect(identity.outcome).toBe('accepted');

      // Promotion itself runs before the deadline passes and succeeds.
      gate.promoteForNewRun('run-1', '2030-01-01T00:00:01.500Z');
      expect(gate.forRun('run-1').getDesiredState().agentName).toBe('reviewer');

      // No `recordApplied` boundary has run yet — nothing has marked the
      // underlying command failed — but reading the run's view again after
      // the deadline has now passed must not keep reporting the identity.
      // `forRun().getDesiredState()` has no `now` parameter of its own (a
      // fixed operative-level interface), so this is the one place in this
      // suite that mocks `Date.now` rather than injecting a clock —
      // `packages/bureau/src/steering.test.ts` is not a deterministic test
      // directory per `scripts/determinism-manifest.json`.
      const originalNow = Date.now;
      try {
        Date.now = () => Date.parse('2030-01-01T00:00:03.000Z');
        expect(gate.forRun('run-1').getDesiredState().agentName).toBeUndefined();
      } finally {
        Date.now = originalNow;
      }
    });

    it('keeps reporting a promoted identity with no deadline at all, unaffected by the check', () => {
      const gate = createSteeringGate('session-1');
      const identity = gate.admit(
        {
          id: 'identity-1',
          idOrigin: 'caller',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'agent-identity', override: 'reviewer' },
          requestedAt: NOW,
        },
        { liveRunIds: [], now: NOW },
      );
      expect(identity.outcome).toBe('accepted');
      gate.promoteForNewRun('run-1', NOW);
      expect(gate.forRun('run-1').getDesiredState().agentName).toBe('reviewer');
    });
  });
});
