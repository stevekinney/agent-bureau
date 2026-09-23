/**
 * AB-200 — durable steering survives a real process kill.
 *
 * `steering-durability.test.ts` reaches its restart boundary by disposing
 * a backend cleanly and reopening it. That proves a record survives an
 * orderly shutdown, which is the common case but not the interesting one:
 * a write buffered until `dispose()` flushed it would pass that test and
 * still lose the command in a genuine crash.
 *
 * This test removes the orderly shutdown. A child process admits a
 * steering command through the public `submitSteeringCommand` verb and
 * then SIGKILLs itself — no exit handler, no `dispose()`, no flush. The
 * parent then opens the same SQLite path and asserts the command is
 * recoverable, so whatever it finds was on disk before the process died.
 *
 * No sleeps in the parent: it waits on process exit and on the child's
 * own marker file.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveStorage } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import type { PersistedSteeringCommand } from './steering-durability';
import { createSteeringMailbox, recoverSteeringCommands } from './steering-durability';

const CHILD = join(import.meta.dir, 'test', 'steering-crash-child.ts');

describe('durable steering survives SIGKILL', () => {
  it('recovers a command admitted by a process that was killed without disposing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-crash-'));
    const storagePath = join(directory, 'bureau.sqlite');
    const markerPath = join(directory, 'admitted.json');

    try {
      const child = Bun.spawn(['bun', CHILD, storagePath, markerPath], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await child.exited;

      const stderr = await new Response(child.stderr).text();
      // The child kills itself, so a clean exit code 0 would mean it
      // returned normally instead — which would invalidate the whole
      // premise of the test rather than merely fail an assertion.
      expect(child.signalCode ?? stderr).toBe('SIGKILL');
      expect(existsSync(markerPath)).toBe(true);

      const { sessionId } = JSON.parse(readFileSync(markerPath, 'utf8')) as {
        sessionId: string;
      };

      // Fresh handle on the same backend, in this process. Nothing is
      // shared with the dead one but the bytes it left on disk.
      const storage = await resolveStorage({ type: 'sqlite', path: storagePath });
      const mailbox = createSteeringMailbox(storage, sessionId);
      const recovered: PersistedSteeringCommand[] = [];
      await recoverSteeringCommands(mailbox, (command) => recovered.push(command));

      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.id).toBe('crash-cmd-1');
      expect(recovered[0]?.principal).toBe('alice');
      expect(recovered[0]?.requestedValue).toEqual({ target: 'pause' });

      mailbox.dispose();
      storage[Symbol.dispose]();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
