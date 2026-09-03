/**
 * `SelectionGate` — the AB-67-style boundary consulted for backend
 * selection (AB-64's decision record; AB-250/mod-03c).
 *
 * Mirrors `SteeringGate`'s shape and role: `runStep` reads it once per step,
 * at the same shared entry boundary the steering gate is already read
 * (immediately after the abort check and after the pause-wait loop, before
 * backpressure — see `run-step.ts`'s boundary comment). A run with no
 * `RunOptions.selection` configured behaves exactly as it does today; the
 * boundary read is a complete no-op.
 *
 * Both `getPlan()` and `revalidate()` are synchronous and pure, because
 * `select` (AB-249, `providers/selection.ts`) is pure: neither performs
 * input or output, awaits a provider, or starts background work. `revalidate()`
 * may read mutable state through the closures a caller supplies to
 * {@link createSelectionGate} (Bureau's live catalog and policy revisions,
 * typically) — "pure" here means the same thing it means for
 * `SteeringGate.getDesiredState()`: no I/O, no async, no side effect on the
 * world outside this gate's own recorded plan, not referential transparency
 * against a frozen universe.
 *
 * Out of scope, per AB-250's delivery boundary: applying a replacement plan
 * to an in-flight generate call (an ABP-11 non-goal — a replacement plan is
 * recorded and takes effect no earlier than the NEXT generation boundary);
 * `submitSteeringCommand`/`policyRef` resolution through the selector
 * (AB-200); retargeting an active provider request.
 */

import {
  select,
  type SelectionPlan,
  type SelectionRequest,
  type SelectOptions,
} from './providers/selection.ts';

export type { SelectionPlan, SelectionRequest, SelectOptions };

/**
 * Per-run gate `runStep` consults at its AB-67-sibling boundary to
 * revalidate a previously-planned backend selection against the current
 * catalog/policy/availability snapshot. Supplied via `RunOptions.selection`.
 * Optional: a run with no `selection` dependency proceeds exactly as it
 * does today, with no behavior change.
 */
export interface SelectionGate {
  /**
   * Synchronous read of this gate's most recently recorded `SelectionPlan`.
   * `undefined` before any selection has ever been recorded — a gate
   * constructed with no `initialPlan` and never yet revalidated.
   */
  getPlan(): SelectionPlan | undefined;
  /**
   * Re-evaluates the recorded plan against the CURRENT catalog, policy, and
   * availability revisions and returns the resulting plan — `'selected'`
   * again when nothing that matters has moved, or a typed replacement
   * outcome (`'capability-changed'`, `'policy-changed'`, `'no-candidate'`,
   * …) when it has. Updates this gate's recorded plan to the result before
   * returning it, so a subsequent `getPlan()` observes the same value.
   *
   * Never mutates a superseded plan's `selected` — a replacement plan is a
   * new, distinct `SelectionPlan` value; the one it replaces is returned
   * unchanged by any earlier `getPlan()` caller that still holds it.
   */
  revalidate(): SelectionPlan;
}

/**
 * Builds the {@link SelectionRequest}/{@link SelectOptions} pair `select`
 * needs, read fresh on every call — see {@link createSelectionGate}.
 */
export interface SelectionGateSource {
  /** The recorded input signature `select` checks determinism against. Read
   *  fresh on every `revalidate()` call so it reflects Bureau's CURRENT
   *  catalog/policy/availability revisions, never a value captured once at
   *  gate-construction time. */
  request(): SelectionRequest;
  /** The catalog and five policy layers `select` composes against. Read
   *  fresh on every `revalidate()` call for the same reason as `request()`. */
  options(): SelectOptions;
}

export interface CreateSelectionGateOptions extends SelectionGateSource {
  /** The plan this gate starts with — typically the result of an earlier,
   *  standalone `planSelection(...)` call made before the run began.
   *  Absent when no selection has been planned yet. */
  readonly initialPlan?: SelectionPlan;
}

/**
 * Reference implementation of {@link SelectionGate}. `revalidate()` compares
 * the recorded plan's `catalogRevision`/`policyRevision` (and, through
 * `request().availabilitySnapshotRevision`, availability) against the
 * CURRENT values `source.request()`/`source.options()` report:
 *
 * - Nothing changed (`catalogRevision`, `policyRevision`, and
 *   `availabilitySnapshotRevision` all identical to the recorded plan's own
 *   request) — a pure no-op, returning the SAME plan object by reference.
 *   This is "compares the plan's recorded revisions against current values"
 *   (AB-250's acceptance criteria) at its simplest: nothing to revalidate.
 * - `catalogRevision` differs from the recorded plan's — `select`'s own
 *   `options.revalidate` branch decides: `'capability-changed'` when the
 *   previously selected candidate is no longer eligible under the new
 *   catalog, `'selected'` again (a fresh plan, same or different winner)
 *   otherwise.
 * - `policyRevision` differs — the same branch yields `'policy-changed'`
 *   under the identical no-longer-eligible condition.
 * - Only `availabilitySnapshotRevision` differs (catalog and policy
 *   revisions unchanged) — `select`'s revalidate branch does not compare
 *   this field at all (AB-249/mod-03b fixed it to compare only catalog and
 *   policy revisions), so an availability-only change that removes the last
 *   eligible candidate falls through to `select`'s ordinary
 *   zero-eligible-candidates path and surfaces as `'no-candidate'` — not
 *   `'capability-changed'` — matching AB-250's own acceptance criterion
 *   ("a run whose only candidate becomes `availability: 'unavailable'`...
 *   fails with the typed `no-candidate` outcome").
 *
 * Every branch supplies `options.revalidate` (never omits it) so `select`'s
 * own comparison — not a duplicate one here — is the single source of truth
 * for what counts as a change; this gate's only added behavior is the
 * nothing-changed fast path and updating its own recorded plan.
 */
export function createSelectionGate(options: CreateSelectionGateOptions): SelectionGate {
  let current: SelectionPlan | undefined = options.initialPlan;

  function revalidate(): SelectionPlan {
    const request = options.request();
    const selectOptions = options.options();

    if (current === undefined) {
      const plan = select(request, selectOptions);
      current = plan;
      return plan;
    }

    // The no-op fast path applies to ANY recorded plan — including one that
    // never reached `outcome: 'selected'` — because `catalogRevision`/
    // `policyRevision`/`request.availabilitySnapshotRevision` are common
    // fields present on every `SelectionPlan` regardless of outcome
    // (Copilot review PRRT_kwDORvupsc6e7CDo). A prior non-'selected' plan
    // recomputed under otherwise-identical revisions would only reproduce
    // the same failure, so skipping straight to the same recorded plan by
    // reference matches the documented "nothing changed" contract exactly.
    const unchanged =
      current.catalogRevision === request.catalogRevision &&
      current.policyRevision === request.policyRevision &&
      current.request.availabilitySnapshotRevision === request.availabilitySnapshotRevision;
    if (unchanged) return current;

    // `select`'s `revalidate` option requires a real `priorSelected`
    // candidate to compare the new catalog/policy against — a prior plan
    // that never selected one (e.g. `'no-candidate'`) has nothing to supply
    // there, so it falls through to a plain fresh `select()` instead, same
    // as the never-revalidated (`current === undefined`) case above.
    const plan =
      current.selected === undefined
        ? select(request, selectOptions)
        : select(request, {
            ...selectOptions,
            revalidate: {
              priorSelected: current.selected,
              priorCatalogRevision: current.catalogRevision,
              priorPolicyRevision: current.policyRevision,
            },
          });
    current = plan;
    return plan;
  }

  return {
    getPlan: () => current,
    revalidate,
  };
}
