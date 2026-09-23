import type { SteeringDesiredState } from './durable/types';
import type {
  GenerationBackendRecord,
  GenerationDivergence,
  GenerationSelectionRecord,
} from './events';
import type { SelectionPlan } from './providers/selection';

/**
 * AB-68 — composes the record `generate.started` carries from the two
 * sources that know anything about a generation's configuration: AB-64's
 * `SelectionPlan` (what the selector chose) and AB-67's
 * `SteeringDesiredState` (what the session has since asked for).
 *
 * Pure and synchronous. It reads two already-resolved values and performs
 * no selection of its own — the plan was chosen at `prepareStep`'s
 * selection boundary and the desired state was read at the same boundary,
 * so composing them here cannot observe a value the step did not act on.
 */

/** The four fields steering can address, in a fixed order so two records
 *  built from the same inputs compare byte-for-byte. */
const STEERABLE_FIELDS = ['provider', 'model', 'route', 'effort'] as const;

/**
 * `undefined` when the run has neither gate. An unconfigured run knows none
 * of these coordinates, and an all-`undefined` record would be
 * indistinguishable from one whose fields genuinely resolved to nothing.
 */
export function composeGenerationSelectionRecord(
  plan: SelectionPlan | undefined,
  steering: SteeringDesiredState | undefined,
): GenerationSelectionRecord | undefined {
  if (plan === undefined && steering === undefined) return undefined;

  const selected: GenerationBackendRecord | undefined =
    plan?.outcome === 'selected' && plan.selected !== undefined
      ? {
          provider: plan.selected.provider,
          model: plan.selected.model,
          route: plan.selected.route,
          effort: plan.selected.effort,
        }
      : undefined;

  // Steering wins field by field, not wholesale: a command that steers only
  // `effort` must not discard the plan's provider and model. An absent
  // steering field is "unspecified", never "clear the plan's value" —
  // `SteeringDesiredState`'s own fields are optional precisely so a
  // single-field command can exist.
  const effective: GenerationBackendRecord = {
    provider: steering?.provider ?? selected?.provider,
    model: steering?.model ?? selected?.model,
    route: steering?.route ?? selected?.route,
    effort: steering?.effort ?? selected?.effort,
  };

  const divergence: GenerationDivergence[] = [];
  // Divergence is only meaningful against a plan that actually selected
  // something. With no `selected` there is nothing to diverge FROM, and
  // reporting every steered field as a divergence would turn "this run has
  // no selector" into a wall of false divergence.
  if (selected !== undefined) {
    for (const field of STEERABLE_FIELDS) {
      const plannedValue = selected[field];
      const effectiveValue = effective[field];
      if (plannedValue === effectiveValue) continue;
      divergence.push({
        field,
        reason: 'steering-override',
        planned: plannedValue,
        effective: effectiveValue,
      });
    }
  }

  const fallbackPlan: GenerationBackendRecord[] =
    plan?.fallbackPlan.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      route: entry.route,
    })) ?? [];

  return {
    planId: plan?.planId,
    planOutcome: plan?.outcome,
    selected,
    effective,
    configVersion: steering?.configVersion,
    divergence,
    fallbackPlan,
  };
}
