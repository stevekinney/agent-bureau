/**
 * The process-crash conformance harness (AB-270): launches `fixture.ts` as a
 * real, separate OS process over a unique temporary SQLite backend,
 * SIGKILLs it the instant it reports a named `CrashMarker`, then launches a
 * fresh process over the SAME backend path and drives it to completion.
 *
 * Every wait here is an IPC message (a line read off the child's stdout) or
 * `child.exited` — never a sleep, never a poll on wall time. The parent
 * never calls `SIGTERM` and never asks the first process to dispose
 * anything before killing it: the entire point of this tier is proving
 * recovery from an ABRUPT loss, not a graceful one.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { ManualRuntimeServices } from '@lostgradient/operative/test';
import { createSqliteStorageFixture } from 'bureau/test';

import {
  type CrashFixtureMessage,
  type CrashMarker,
  type CrashParentCommand,
  decodeCrashFixtureMessage,
  encodeCrashLine,
  type JsonValue,
} from './protocol';

/** Thrown before any process is spawned when `options.backend` names a backend this harness cannot exercise yet. */
export class CrashHarnessUnsupportedBackendError extends Error {
  readonly backend: string;

  constructor(backend: string) {
    super(
      `Crash-conformance harness (AB-270) supports only the "sqlite" backend on this ` +
        `baseline; "${backend}" is not supported. LMDB is AB-271's scope.`,
    );
    this.name = 'CrashHarnessUnsupportedBackendError';
    this.backend = backend;
  }
}

export interface CrashScenarioOptions {
  /** Names the marker the FIRST process is killed at, with `SIGKILL`, the instant it is reported. */
  readonly killAtMarker: CrashMarker;
  /**
   * The harness identifier source (AB-92's `RuntimeServices`) used to name
   * the unique temporary SQLite path this scenario allocates. Two
   * scenarios sharing one `runtime` still never collide — see
   * `storage-fixtures.ts`'s own per-instance sequence.
   */
  readonly runtime: ManualRuntimeServices;
  /** Only `'sqlite'` is supported on this baseline (AB-271 owns LMDB). Defaults to `'sqlite'`. */
  readonly backend?: 'sqlite';
}

export interface CrashMarkerObservation {
  readonly marker: CrashMarker;
  readonly detail?: Record<string, JsonValue>;
}

export interface CrashObservation {
  readonly label: string;
  readonly value: JsonValue;
}

export interface CrashProcessOutcome {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signalCode: string | number | null;
  readonly markers: readonly CrashMarkerObservation[];
  readonly observations: readonly CrashObservation[];
  readonly fatal?: { readonly message: string; readonly stack?: string };
}

export interface CrashScenarioReport {
  readonly storagePath: string;
  readonly killedAtMarker: CrashMarker;
  /** The first process — killed with `SIGKILL` at `killedAtMarker` (or exited on its own if it never reached it). */
  readonly first: CrashProcessOutcome;
  /** The second process — launched fresh over the same backend path, always run to a clean exit. */
  readonly second: CrashProcessOutcome;
  /** `true` when, after both processes exited, no descendant of either process's pid was still alive. */
  readonly noOrphanedProcesses: boolean;
}

function observation(
  message: Extract<CrashFixtureMessage, { type: 'marker' }>,
): CrashMarkerObservation {
  return { marker: message.marker, ...(message.detail ? { detail: message.detail } : {}) };
}

/** Reads newline-delimited text off a `ReadableStream<Uint8Array>`, yielding one complete line at a time. */
async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        yield buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    }
    if (buffer.trim().length > 0) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

interface DriveResult {
  readonly markers: CrashMarkerObservation[];
  readonly observations: CrashObservation[];
  fatal?: { message: string; stack?: string };
  killedAt?: CrashMarker;
}

/**
 * Consumes one fixture process's stdout line-by-line and answers every
 * marker report:
 *
 * - When `killAtMarker` is reported, the process is killed immediately
 *   (`SIGKILL`, no acknowledgement sent) and this returns as soon as the
 *   line loop itself ends (the pipe closes once the kill lands).
 * - Otherwise every marker is acknowledged with `{ type: 'proceed' }`,
 *   except `'signal-parked'`, which is always answered `{ type: 'cancel' }`
 *   — this harness's one linear scenario always drives the run to
 *   cancellation rather than delivering the human-input signal.
 *
 * A stdout line that fails to decode as a `CrashFixtureMessage` is forwarded
 * to the parent's own stderr as a diagnostic and otherwise ignored, rather
 * than treated as a protocol violation — a dependency underneath the
 * fixture is free to log to stdout.
 */
async function driveProcess(
  child: {
    readonly pid: number;
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stdin: {
      write(chunk: string): number | Promise<number>;
      flush(): number | Promise<number>;
    };
    kill(signal?: number | NodeJS.Signals): void;
  },
  killAtMarker: CrashMarker | undefined,
): Promise<DriveResult> {
  const result: DriveResult = { markers: [], observations: [] };

  async function send(command: CrashParentCommand): Promise<void> {
    // Awaited, not fire-and-forget: `write`/`flush` can return a pending
    // Promise, and a rejection left unhandled here would surface as an
    // unhandled rejection while the fixture sits blocked on stdin forever
    // — failing fast keeps IPC pacing deterministic instead of hanging.
    await child.stdin.write(`${encodeCrashLine(command)}\n`);
    await child.stdin.flush();
  }

  for await (const line of readLines(child.stdout)) {
    let message: CrashFixtureMessage;
    try {
      message = decodeCrashFixtureMessage(line);
    } catch {
      process.stderr.write(`[crash-fixture pid=${child.pid} non-protocol stdout] ${line}\n`);
      continue;
    }

    if (message.type === 'marker') {
      result.markers.push(observation(message));
      if (killAtMarker && message.marker === killAtMarker) {
        result.killedAt = message.marker;
        child.kill('SIGKILL');
        continue;
      }
      await send(message.marker === 'signal-parked' ? { type: 'cancel' } : { type: 'proceed' });
      continue;
    }
    if (message.type === 'observation') {
      result.observations.push({ label: message.label, value: message.value });
      continue;
    }
    if (message.type === 'fatal') {
      result.fatal = {
        message: message.message,
        ...(message.stack ? { stack: message.stack } : {}),
      };
    }
  }

  return result;
}

function fixtureEntryPath(): string {
  return join(new URL('.', import.meta.url).pathname, 'fixture.ts');
}

async function spawnFixture(
  storagePath: string,
  mode: 'primary' | 'recovery',
  rootRunId: string | undefined,
): Promise<Bun.Subprocess<'pipe', 'pipe', 'inherit'>> {
  const args = [fixtureEntryPath(), storagePath, mode, ...(rootRunId ? [rootRunId] : [])];
  return Bun.spawn({
    cmd: ['bun', ...args],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    detached: true,
  });
}

/**
 * `true` only when `pid`'s process group has nothing alive left in it.
 * `pid` was spawned with `detached: true`, so its process group id equals
 * its own pid — signaling `-pid` targets the whole group. `process.kill`
 * with signal `0` sends nothing; it only probes existence, throwing
 * `ESRCH` when no process (or, for a negative pid, no process GROUP)
 * matches. This needs no external binary (no `pgrep` dependency, portable
 * across platforms and minimal CI/dev images) and reads the exact
 * guarantee `detached: true` provides directly, rather than inferring it
 * from a scan tool's own exit code.
 */
function processGroupIsClean(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    // No throw: at least one process in the group is still alive.
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function findRootRunId(markers: readonly CrashMarkerObservation[]): string | undefined {
  for (const entry of markers) {
    if (entry.marker === 'run-started') {
      const runId = entry.detail?.['runId'];
      return typeof runId === 'string' ? runId : undefined;
    }
  }
  return undefined;
}

/**
 * Runs one crash scenario end to end: allocates a unique temporary SQLite
 * path, launches `fixture.ts` as the first process, kills it at
 * `options.killAtMarker`, launches a second `fixture.ts` process over the
 * same path, drives it to a clean exit, and cleans up the temporary path
 * (including its `-wal`/`-shm` sidecars) — even when the first process was
 * killed mid-write.
 */
export async function runCrashScenario(
  options: CrashScenarioOptions,
): Promise<CrashScenarioReport> {
  const backend = options.backend ?? 'sqlite';
  if (backend !== 'sqlite') {
    throw new CrashHarnessUnsupportedBackendError(backend);
  }

  const storage = createSqliteStorageFixture({ runtime: options.runtime });
  const storagePath = storage.path;
  if (!storagePath) {
    throw new Error('crash harness: sqlite storage fixture did not allocate a path');
  }

  try {
    const firstProcess = await spawnFixture(storagePath, 'primary', undefined);
    const firstDrive = await driveProcess(firstProcess, options.killAtMarker);
    const firstExitCode = await firstProcess.exited;

    const first: CrashProcessOutcome = {
      pid: firstProcess.pid,
      exitCode: firstExitCode,
      signalCode: firstProcess.signalCode,
      markers: firstDrive.markers,
      observations: firstDrive.observations,
      ...(firstDrive.fatal ? { fatal: firstDrive.fatal } : {}),
    };

    const rootRunId = findRootRunId(firstDrive.markers);

    const secondProcess = await spawnFixture(storagePath, 'recovery', rootRunId);
    const secondDrive = await driveProcess(secondProcess, undefined);
    const secondExitCode = await secondProcess.exited;

    const second: CrashProcessOutcome = {
      pid: secondProcess.pid,
      exitCode: secondExitCode,
      signalCode: secondProcess.signalCode,
      markers: secondDrive.markers,
      observations: secondDrive.observations,
      ...(secondDrive.fatal ? { fatal: secondDrive.fatal } : {}),
    };

    const firstClean = processGroupIsClean(firstProcess.pid);
    const secondClean = processGroupIsClean(secondProcess.pid);

    return {
      storagePath,
      killedAtMarker: options.killAtMarker,
      first,
      second,
      noOrphanedProcesses: firstClean && secondClean,
    };
  } finally {
    await storage.dispose();
    // Belt-and-suspenders beyond the fixture's own `-wal`/`-shm` cleanup:
    // confirm the primary file itself is gone too (dispose() already does
    // this; this loop is here so a future dispose() regression fails this
    // harness's own callers loudly instead of leaking silently).
    await rm(storagePath, { force: true });
  }
}
