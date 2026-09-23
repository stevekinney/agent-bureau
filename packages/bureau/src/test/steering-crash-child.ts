/**
 * AB-200 — the child half of the durable-steering SIGKILL test.
 *
 * Stands up a real durable Bureau on the SQLite path given as `argv[2]`,
 * admits a steering command through the public verb, writes the marker
 * file at `argv[3]`, and then kills itself with SIGKILL.
 *
 * The self-kill is the point. Every other durability test in this package
 * reaches its restart boundary by disposing cleanly and reopening, which
 * proves the record survives an orderly shutdown. It does not prove the
 * record was durably committed at the moment admission returned — a
 * buffered write flushed by `dispose()` would pass that test and lose the
 * command in a real crash. SIGKILL runs no exit handler, no `dispose()`,
 * and no flush, so whatever the parent finds afterwards was genuinely on
 * disk before the process died.
 *
 * Not a test file: it is spawned by `steering-crash-recovery.test.ts`.
 */
import { writeFileSync } from 'node:fs';

import { createToolbox } from 'armorer';

import { createBureau } from '../create-bureau';

const storagePath = process.argv[2];
const markerPath = process.argv[3];

if (storagePath === undefined || markerPath === undefined) {
  process.stderr.write('usage: steering-crash-child <storagePath> <markerPath>\n');
  process.exit(2);
}

const bureau = await createBureau({
  agents: {},
  generate: () => new Promise<never>(() => {}),
  toolbox: createToolbox([]),
  storage: { type: 'sqlite', path: storagePath },
  durableExecution: true,
});

const run = await bureau.createRun({ message: 'Wait forever', principal: 'alice' });

// Poll rather than sleep: the run must actually be live before a pause is
// admissible, and a fixed delay would either be flaky or slow.
for (let attempt = 0; attempt < 200; attempt += 1) {
  const session = await bureau.getSession(run.sessionId);
  if (session?.metadata['lastRunStatus'] === 'running') break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const outcome = await bureau.submitSteeringCommand(run.sessionId, {
  id: 'crash-cmd-1',
  principal: 'alice',
  requestedValue: { target: 'pause' },
});

if (outcome.outcome !== 'accepted') {
  process.stderr.write(`child: expected accepted, got ${outcome.outcome}\n`);
  process.exit(3);
}

// The parent reads this to learn the session id and that admission
// returned. Written synchronously so it is on disk before the kill.
writeFileSync(markerPath, JSON.stringify({ sessionId: run.sessionId }), 'utf8');

// No `bureau.dispose()`, deliberately. SIGKILL cannot be trapped, so no
// cleanup, no flush, no graceful close runs after this line.
process.kill(process.pid, 'SIGKILL');
