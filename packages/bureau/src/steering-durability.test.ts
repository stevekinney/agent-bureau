/**
 * AB-200 — durable steering.
 *
 * The restart boundary is a genuine one: two independently constructed
 * `Mailbox` instances over the same reopened SQLite backend, with the
 * first disposed before the second opens. No sleeps and no real process
 * kill — the durability being tested is the storage backend's, and
 * reopening it is exactly what a restart does to it.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { resolveStorage } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import type { ImplementedSteeringCommand } from './steering';
import type { PersistedSteeringCommand } from './steering-durability';
import {
  createSteeringMailbox,
  persistSteeringCommand,
  recoverSteeringCommands,
} from './steering-durability';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { throwingRejectionOf } from './testing/promise-outcome.test-support.ts';

function steeringCommand(
  overrides: Partial<ImplementedSteeringCommand> = {},
): ImplementedSteeringCommand {
  return {
    id: 'cmd-1',
    idOrigin: 'caller',
    sessionId: 'session-1',
    principal: 'alice',
    requestedValue: { target: 'model', override: 'claude-sonnet-5' },
    requestedAt: '2026-09-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('durable steering', () => {
  it('recovers an admitted command across a restart of the storage backend', async () => {
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    try {
      const storageBefore = await resolveStorage(fixture.configuration);
      const mailboxBefore = createSteeringMailbox(storageBefore, 'session-1');
      const persisted = await persistSteeringCommand(mailboxBefore, steeringCommand());
      expect(persisted.persisted).toBe(true);
      mailboxBefore.dispose();
      storageBefore[Symbol.dispose]();

      // Restart: a second backend handle over the same path, and a
      // mailbox that shares nothing in memory with the first.
      const storageAfter = await resolveStorage(fixture.configuration);
      const mailboxAfter = createSteeringMailbox(storageAfter, 'session-1');
      const recovered: PersistedSteeringCommand[] = [];
      await recoverSteeringCommands(mailboxAfter, (command) => recovered.push(command));

      // The full reconstructed record, not a spot-check of some fields:
      // optional fields the command never carried must stay absent rather
      // than being reconstructed as placeholders.
      expect(recovered).toEqual([
        {
          id: 'cmd-1',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'model', override: 'claude-sonnet-5' },
          requestedAt: '2026-09-19T00:00:00.000Z',
        },
      ]);

      mailboxAfter.dispose();
      storageAfter[Symbol.dispose]();
    } finally {
      await fixture.dispose();
    }
  });

  it('preserves FIFO order across a restart, so the last value wins', async () => {
    // Replaying a later model change before an earlier one would leave
    // the wrong value in force, which is the whole reason order matters.
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    try {
      const storageBefore = await resolveStorage(fixture.configuration);
      const mailboxBefore = createSteeringMailbox(storageBefore, 'session-1');
      await persistSteeringCommand(
        mailboxBefore,
        steeringCommand({ id: 'cmd-1', requestedValue: { target: 'model', override: 'first' } }),
      );
      await persistSteeringCommand(
        mailboxBefore,
        steeringCommand({ id: 'cmd-2', requestedValue: { target: 'model', override: 'second' } }),
      );
      mailboxBefore.dispose();
      storageBefore[Symbol.dispose]();

      const storageAfter = await resolveStorage(fixture.configuration);
      const mailboxAfter = createSteeringMailbox(storageAfter, 'session-1');
      const recovered: PersistedSteeringCommand[] = [];
      await recoverSteeringCommands(mailboxAfter, (command) => recovered.push(command));

      expect(recovered).toEqual([
        {
          id: 'cmd-1',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'model', override: 'first' },
          requestedAt: '2026-09-19T00:00:00.000Z',
        },
        {
          id: 'cmd-2',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'model', override: 'second' },
          requestedAt: '2026-09-19T00:00:00.000Z',
        },
      ]);

      mailboxAfter.dispose();
      storageAfter[Symbol.dispose]();
    } finally {
      await fixture.dispose();
    }
  });

  it('does not duplicate a command when the same id is persisted twice', async () => {
    // The idempotency key is the caller-facing command id, so an exact
    // retry replays the original receipt instead of creating a second
    // command that a restart would then apply twice.
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    try {
      const storage = await resolveStorage(fixture.configuration);
      const mailbox = createSteeringMailbox(storage, 'session-1');
      const first = await persistSteeringCommand(mailbox, steeringCommand());
      const second = await persistSteeringCommand(mailbox, steeringCommand());

      expect(first.persisted && second.persisted).toBe(true);
      if (first.persisted && second.persisted) {
        expect(second.commandId).toBe(first.commandId);
      }

      const recovered: PersistedSteeringCommand[] = [];
      await recoverSteeringCommands(mailbox, (command) => recovered.push(command));
      expect(recovered).toEqual([
        {
          id: 'cmd-1',
          sessionId: 'session-1',
          principal: 'alice',
          requestedValue: { target: 'model', override: 'claude-sonnet-5' },
          requestedAt: '2026-09-19T00:00:00.000Z',
        },
      ]);

      mailbox.dispose();
      storage[Symbol.dispose]();
    } finally {
      await fixture.dispose();
    }
  });

  it('drains the log, so a second recovery pass finds nothing', async () => {
    // Recovery consumes: acknowledging each command is what stops a
    // restart from re-applying the same steering forever.
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    try {
      const storage = await resolveStorage(fixture.configuration);
      const mailbox = createSteeringMailbox(storage, 'session-1');
      await persistSteeringCommand(mailbox, steeringCommand());

      expect(await recoverSteeringCommands(mailbox, () => {})).toBe(1);
      expect(await recoverSteeringCommands(mailbox, () => {})).toBe(0);

      mailbox.dispose();
      storage[Symbol.dispose]();
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps separate sessions in separate mailboxes', async () => {
    // FIFO order is meaningful within a session and meaningless across
    // unrelated ones, so one session's log must never recover another's.
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    try {
      const storage = await resolveStorage(fixture.configuration);
      const first = createSteeringMailbox(storage, 'session-1');
      const second = createSteeringMailbox(storage, 'session-2');
      await persistSteeringCommand(first, steeringCommand({ sessionId: 'session-1' }));

      expect(await recoverSteeringCommands(second, () => {})).toBe(0);
      expect(await recoverSteeringCommands(first, () => {})).toBe(1);

      first.dispose();
      second.dispose();
      storage[Symbol.dispose]();
    } finally {
      await fixture.dispose();
    }
  });
});

describe('durable steering with nothing to reconstruct', () => {
  it('reports an empty mailbox as empty and recovers nothing', async () => {
    // The empty case, as this file already defines it: `claim()` answers
    // `{ status: 'empty' }` and recovery neither applies nor counts anything.
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    try {
      const storage = await resolveStorage(fixture.configuration);
      const mailbox = createSteeringMailbox(storage, 'session-1');
      const recovered: PersistedSteeringCommand[] = [];

      expect(await mailbox.claim()).toEqual({ status: 'empty' });
      expect(await recoverSteeringCommands(mailbox, (command) => recovered.push(command))).toBe(0);
      expect(recovered).toEqual([]);
      expect(await mailbox.list()).toEqual([]);

      mailbox.dispose();
      storage[Symbol.dispose]();
    } finally {
      await fixture.dispose();
    }
  });

  it('is empty again after a drained recovery, across a restart', async () => {
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    try {
      const storageBefore = await resolveStorage(fixture.configuration);
      const mailboxBefore = createSteeringMailbox(storageBefore, 'session-1');
      await persistSteeringCommand(mailboxBefore, steeringCommand());
      expect(await recoverSteeringCommands(mailboxBefore, () => {})).toBe(1);
      mailboxBefore.dispose();
      storageBefore[Symbol.dispose]();

      const storageAfter = await resolveStorage(fixture.configuration);
      const mailboxAfter = createSteeringMailbox(storageAfter, 'session-1');
      const recovered: PersistedSteeringCommand[] = [];
      expect(await mailboxAfter.claim()).toEqual({ status: 'empty' });
      expect(await recoverSteeringCommands(mailboxAfter, (c) => recovered.push(c))).toBe(0);
      expect(recovered).toEqual([]);

      mailboxAfter.dispose();
      storageAfter[Symbol.dispose]();
    } finally {
      await fixture.dispose();
    }
  });
});

describe('durable steering crash safety', () => {
  it('leaves a command recoverable when the replay throws before acknowledgement', async () => {
    // The defect this pins: an earlier version acknowledged every command
    // as it drained and let the caller admit the batch afterwards, so a
    // crash between the two lost the command from both sides at once —
    // durably forgotten, never applied. Apply now runs per command,
    // before its acknowledgement, so a failure leaves the command
    // claimed; its lease expires and the next pass replays it.
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    try {
      const storage = await resolveStorage(fixture.configuration);
      const mailbox = createSteeringMailbox(storage, 'session-1');
      const persisted = await persistSteeringCommand(mailbox, steeringCommand());
      if (!persisted.persisted) throw new Error('expected the command to persist');

      expect(
        await throwingRejectionOf(
          recoverSteeringCommands(mailbox, () => {
            throw new Error('replay failed');
          }),
        ),
      ).toThrow('replay failed');

      // Not acknowledged, so still durably present. The receipt is
      // still `claimed` (its lease has not expired, so a second `claim()`
      // sees nothing claimable) rather than gone — the record survived the
      // failed replay, which is the whole guarantee.
      const receipts = await mailbox.list();
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.commandId).toBe(persisted.commandId);
      expect(receipts[0]?.state).toBe('claimed');
      expect(await mailbox.claim()).toEqual({ status: 'empty' });

      mailbox.dispose();
      storage[Symbol.dispose]();
    } finally {
      await fixture.dispose();
    }
  });
});
