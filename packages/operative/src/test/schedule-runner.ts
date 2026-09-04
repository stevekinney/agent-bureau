// ---------------------------------------------------------------------------
// AB-267 — the bounded interleaving runner (AB-95's tst-04c slice, AB-92's
// testability contract). `runBoundedSchedules` replaces "run the suite a
// few hundred times and hope a race shows up" with a deterministic,
// seed-reproducible enumeration of every ordering of two or three named
// parties' barrier releases: it drives a caller-supplied `scenario` through
// each ordering in turn, in a fixed seed-derived sequence, and stops the
// moment one ordering's scenario reports a failure — never retrying it,
// never running past `maximumSchedules`, never touching a real timer.
//
// The runner deliberately knows nothing about what a "party" represents in
// product terms — that is the scenario's business. What it owns is turning
// an ordering (`readonly string[]`, e.g. `['reader', 'writer']`) into a
// concrete, per-schedule `Schedule` the scenario can coordinate real
// asynchronous work against via `AB-266`'s `BarrierRegistry`.
// ---------------------------------------------------------------------------

import { createManualRuntimeServices } from 'lifecycle';

import type { Barrier, BarrierRegistry } from './barriers';

/**
 * One candidate interleaving handed to a scenario. `order` is this
 * schedule's release ordering; `barrier(party)` returns a `Barrier` scoped
 * to THIS schedule alone (never shared with another schedule attempted by
 * the same `runBoundedSchedules` call — see the module doc on barrier reuse
 * below), so a scenario's guarded work for `party` calls
 * `schedule.barrier(party).arrive()` at its coordination point exactly the
 * same way it would against any other `Barrier`. `releaseInOrder()` is a
 * convenience that awaits each party's arrival and releases it, strictly in
 * `order` — the usual way a scenario drives the ordering once its guarded
 * work is started concurrently.
 */
export interface Schedule {
  readonly order: readonly string[];
  barrier(party: string): Barrier;
  releaseInOrder(): Promise<void>;
}

export interface BoundedScheduleOptions {
  readonly barriers: BarrierRegistry;
  /** Two or three party names. Any other length throws {@link InvalidPartyCountError}. */
  readonly parties: readonly string[];
  readonly scenario: (schedule: Schedule) => Promise<void>;
  /**
   * Caps how many schedules this call may run. Required — there is no
   * default and no unbounded mode. When `maximumSchedules` is at least the
   * full permutation count (`parties.length!`), every distinct ordering is
   * attempted and `schedulesRun` on a pass equals that permutation count,
   * not `maximumSchedules` itself, since the runner never invents
   * orderings beyond the ones two or three named parties actually admit.
   */
  readonly maximumSchedules: number;
  /**
   * Deterministically fixes the ORDER schedules are attempted in (a seeded
   * shuffle of the permutation list — see {@link deterministicOrder}), not
   * whether any of them fail. The same seed against the same `parties`
   * always attempts schedules in the same sequence, so a schedule that
   * failed once fails again on an identical re-run.
   */
  readonly seed: string;
}

export interface BoundedScheduleReport {
  readonly schedulesRun: number;
  /** The ordering that failed, present only when a schedule failed before exhaustion. */
  readonly failingSchedule?: readonly string[];
  readonly seed: string;
}

/** Thrown when `parties.length` is anything other than two or three. */
export class InvalidPartyCountError extends Error {
  readonly partyCount: number;
  constructor(partyCount: number) {
    super(
      `runBoundedSchedules: parties.length must be 2 or 3, got ${partyCount}. ` +
        'The bounded interleaving runner enumerates two- and three-party orderings only.',
    );
    this.name = 'InvalidPartyCountError';
    this.partyCount = partyCount;
  }
}

/** Thrown when `maximumSchedules` is not a positive integer. */
export class InvalidMaximumSchedulesError extends Error {
  readonly maximumSchedules: number;
  constructor(maximumSchedules: number) {
    super(
      `runBoundedSchedules: maximumSchedules must be a positive integer, got ${maximumSchedules}. ` +
        'There is no unbounded mode — a schedule count must always be named.',
    );
    this.name = 'InvalidMaximumSchedulesError';
    this.maximumSchedules = maximumSchedules;
  }
}

/** Thrown when two or more entries in `parties` are the same name. */
export class DuplicatePartyNameError extends Error {
  readonly partyName: string;
  constructor(partyName: string) {
    super(
      `runBoundedSchedules: parties must be unique, got a repeated name "${partyName}". ` +
        'A duplicate name would collide on the same per-schedule barrier and collapse ' +
        'distinct permutations into equivalent orderings.',
    );
    this.name = 'DuplicatePartyNameError';
    this.partyName = partyName;
  }
}

/**
 * Thrown by a `scenario` (never by the runner itself) to declare that its
 * lifecycle surface does not exist on this baseline. `runBoundedSchedules`
 * recognizes this specific error and rethrows it immediately rather than
 * recording it as a failing schedule — an unsupported scenario is a
 * capability gap, not a discovered bug, and conflating the two would make a
 * "failing schedule" report untrustworthy.
 */
export class UnsupportedScenarioError extends Error {
  readonly scenarioName: string;
  readonly owningIssue: string;
  constructor(scenarioName: string, owningIssue: string, detail?: string) {
    super(
      `runBoundedSchedules: scenario "${scenarioName}" has no product surface on this ` +
        `baseline; owned by ${owningIssue}.` +
        (detail ? ` ${detail}` : ''),
    );
    this.name = 'UnsupportedScenarioError';
    this.scenarioName = scenarioName;
    this.owningIssue = owningIssue;
  }
}

/** Every distinct permutation of `items`, in a fixed (lexicographic-by-input-order) base sequence before seeding. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const result: T[][] = [];
  for (let index = 0; index < items.length; index++) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    // `index < items.length` here by construction, so this index access is
    // never `undefined`; `noUncheckedIndexedAccess` cannot see that loop
    // invariant, hence the cast.
    const item = items[index] as T;
    for (const tail of permutations(rest)) {
      result.push([item, ...tail]);
    }
  }
  return result;
}

/**
 * Deterministically reorders `items` from `seed` — a Fisher-Yates shuffle
 * driven by `lifecycle`'s own seeded PRNG (`createManualRuntimeServices`),
 * never `Math.random`. The same seed always produces the same output
 * order for the same input list, which is what makes a reported
 * `failingSchedule` reproducible: re-running `runBoundedSchedules` with the
 * same `seed` and `parties` attempts schedules in the identical sequence.
 */
function deterministicOrder<T>(items: readonly T[], seed: string): T[] {
  const random = createManualRuntimeServices({ randomSeed: seed }).random.next;
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index--) {
    const swapWith = Math.floor(random() * (index + 1));
    // Both indices are in bounds by construction (`swapWith` in `[0, index]`,
    // `index` in `[1, copy.length - 1]`); `noUncheckedIndexedAccess` cannot
    // see that, hence the casts.
    const atIndex = copy[index] as T;
    const atSwapWith = copy[swapWith] as T;
    copy[index] = atSwapWith;
    copy[swapWith] = atIndex;
  }
  return copy;
}

/**
 * Builds the one `Schedule` a given attempt hands to `scenario`. `scheduleId`
 * disambiguates this attempt's barrier names from every other attempt in the
 * same `runBoundedSchedules` call: a `BarrierRegistry`'s `barrier(name)`
 * always returns the SAME instance for the same name, and a `Barrier`'s
 * `reached()` promise resolves exactly once and stays resolved forever —
 * reusing a bare party name (e.g. `'writer'`) across every schedule attempt
 * would make every attempt after the first see `reached()` already
 * satisfied from a prior attempt's arrival, silently defeating the ordering
 * this whole module exists to enforce. Namespacing by `scheduleId` keeps
 * every attempt's barriers fresh while still routing through the caller's
 * own `BarrierRegistry`, so the caller's `assertNoPending()` and any
 * recorder attached to it still see every schedule's barrier traffic.
 */
function createSchedule(
  order: readonly string[],
  scheduleId: number,
  registry: BarrierRegistry,
): Schedule {
  function barrier(party: string): Barrier {
    return registry.barrier(`schedule-${scheduleId}:${party}`);
  }

  async function releaseInOrder(): Promise<void> {
    for (const party of order) {
      await barrier(party).reached();
      barrier(party).release();
    }
  }

  return { order, barrier, releaseInOrder };
}

/**
 * Enumerates orderings of `options.parties`' barrier releases, deterministically
 * sequenced by `options.seed`, running `options.scenario` against each in turn
 * up to `options.maximumSchedules`. Stops at the first schedule whose scenario
 * rejects with anything other than {@link UnsupportedScenarioError} (which
 * propagates immediately instead) and reports it as `failingSchedule`.
 * Exhausting every attempted schedule without a failure is a pass.
 */
export async function runBoundedSchedules(
  options: BoundedScheduleOptions,
): Promise<BoundedScheduleReport> {
  const { barriers, parties, scenario, maximumSchedules, seed } = options;

  if (parties.length !== 2 && parties.length !== 3) {
    throw new InvalidPartyCountError(parties.length);
  }
  if (!Number.isInteger(maximumSchedules) || maximumSchedules < 1) {
    throw new InvalidMaximumSchedulesError(maximumSchedules);
  }
  const seenParties = new Set<string>();
  for (const party of parties) {
    if (seenParties.has(party)) {
      throw new DuplicatePartyNameError(party);
    }
    seenParties.add(party);
  }

  const orderings = deterministicOrder(permutations(parties), seed).slice(0, maximumSchedules);

  let schedulesRun = 0;
  for (const order of orderings) {
    schedulesRun++;
    const schedule = createSchedule(order, schedulesRun, barriers);
    try {
      await scenario(schedule);
    } catch (error) {
      if (error instanceof UnsupportedScenarioError) throw error;
      return { schedulesRun, failingSchedule: order, seed };
    }
  }

  return { schedulesRun, seed };
}
