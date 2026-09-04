/**
 * The process-crash conformance harness (AB-270, extended to LMDB by
 * AB-335/AB-271): launches `fixture.ts` as a real, separate OS process over
 * a unique temporary persistent backend, SIGKILLs it the instant it reports
 * a named `CrashMarker`, then launches a fresh process over the SAME
 * backend path and drives it to completion.
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
import { createLmdbStorageFixture, createSqliteStorageFixture } from 'bureau/test';

import {
  type CrashFixtureMessage,
  type CrashMarker,
  type CrashParentCommand,
  decodeCrashFixtureMessage,
  encodeCrashLine,
  type JsonValue,
} from './protocol';

/** The persistent backends the crash-conformance harness can exercise. */
export type CrashBackend = 'sqlite' | 'lmdb';

/** Which fixture process generation a marker was observed on — the first (killed) process or the second (recovered) one. */
export type CrashProcessGeneration = 1 | 2;

/**
 * AB-275: invoked once for every marker EITHER process reports EXCEPT the
 * one `killAtMarker` names, awaited before the harness sends its default
 * `proceed`/`cancel` acknowledgement — so a caller can drive out-of-band
 * work (e.g. a real HTTP/SSE/WebSocket client against a fixture-started
 * gateway) exactly bracketed around one marker, without re-implementing
 * `driveProcess`'s own stdin/stdout pacing loop (the crash-fixture reuse
 * requirement this issue's delivery boundary names). NEVER called for the
 * kill marker, before or after: this function's own contract is that the
 * process dies the INSTANT that marker is observed, with no acknowledgement
 * and no other work in between — an `onMarker` call there would both delay
 * the kill by however long the hook takes and let the hook's own work
 * observe (or race) a process that is about to be abruptly torn down
 * (copilot review, PR #553).
 */
export type CrashMarkerHook = (context: {
  readonly generation: CrashProcessGeneration;
  readonly pid: number;
  readonly marker: CrashMarker;
  readonly detail: Record<string, JsonValue> | undefined;
}) => Promise<void>;

export interface CrashScenarioOptions {
  /** Names the marker the FIRST process is killed at, with `SIGKILL`, the instant it is reported. */
  readonly killAtMarker: CrashMarker;
  /**
   * The harness identifier source (AB-92's `RuntimeServices`) used to name
   * the unique temporary storage path this scenario allocates. Two
   * scenarios sharing one `runtime` still never collide — see
   * `storage-fixtures.ts`'s own per-instance sequence.
   */
  readonly runtime: ManualRuntimeServices;
  /** `'sqlite'` (default) or `'lmdb'` (AB-271/AB-335). */
  readonly backend?: CrashBackend;
  /**
   * When `true` (AB-275), BOTH fixture processes are launched with
   * `--gateway`: each starts a real Gateway loopback listener over the
   * same bureau, reporting its bound port in the `'ready'` marker's own
   * `detail.gatewayPort`. Defaults to `false`.
   */
  readonly gateway?: boolean;
  /** See {@link CrashMarkerHook}. Optional — a scenario with no out-of-band work needs none. */
  readonly onMarker?: CrashMarkerHook;
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
  generation: CrashProcessGeneration,
  onMarker: CrashMarkerHook | undefined,
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
        // Kill FIRST, still with no `onMarker` call and no acknowledgement
        // sent — matching this function's own contract (see its doc
        // comment above): the process is killed the INSTANT this marker is
        // reported. An `onMarker` hook that did out-of-band work before the
        // kill here would let that work observe (or race) a process this
        // scenario is about to abruptly end, and would slow the kill down
        // by however long the hook takes — never done for the kill marker,
        // whether or not a hook is configured (copilot review, PR #553).
        result.killedAt = message.marker;
        child.kill('SIGKILL');
        continue;
      }
      if (onMarker) {
        await onMarker({
          generation,
          pid: child.pid,
          marker: message.marker,
          detail: message.detail,
        });
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
  backend: CrashBackend,
  mode: 'primary' | 'recovery',
  rootRunId: string | undefined,
  gateway: boolean,
): Promise<Bun.Subprocess<'pipe', 'pipe', 'inherit'>> {
  const args = [
    fixtureEntryPath(),
    storagePath,
    backend,
    mode,
    ...(rootRunId ? [rootRunId] : []),
    ...(gateway ? ['--gateway'] : []),
  ];
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
 * Runs one crash scenario end to end: allocates a unique temporary storage
 * path, launches `fixture.ts` as the first process, kills it at
 * `options.killAtMarker`, launches a second `fixture.ts` process over the
 * same path, drives it to a clean exit, and cleans up the temporary path
 * (a file plus its `-wal`/`-shm` sidecars for SQLite, a directory for LMDB)
 * — even when the first process was killed mid-write.
 */
export async function runCrashScenario(
  options: CrashScenarioOptions,
): Promise<CrashScenarioReport> {
  const backend = options.backend ?? 'sqlite';

  const storage =
    backend === 'lmdb'
      ? createLmdbStorageFixture({ runtime: options.runtime })
      : createSqliteStorageFixture({ runtime: options.runtime });
  const storagePath = storage.path;
  if (!storagePath) {
    throw new Error(`crash harness: ${backend} storage fixture did not allocate a path`);
  }

  try {
    const gateway = options.gateway ?? false;
    const firstProcess = await spawnFixture(storagePath, backend, 'primary', undefined, gateway);
    const firstDrive = await driveProcess(firstProcess, options.killAtMarker, 1, options.onMarker);
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

    const secondProcess = await spawnFixture(storagePath, backend, 'recovery', rootRunId, gateway);
    const secondDrive = await driveProcess(secondProcess, undefined, 2, options.onMarker);
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
    // Belt-and-suspenders beyond the fixture's own storage cleanup: confirm
    // the path itself is gone too (dispose() already does this; this call
    // is here so a future dispose() regression fails this harness's own
    // callers loudly instead of leaking silently). LMDB's path is a
    // directory, SQLite's a file — `recursive: true` is a safe no-op for a
    // plain file.
    await rm(storagePath, { recursive: true, force: true });
  }
}
