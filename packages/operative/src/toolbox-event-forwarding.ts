import type { AnyToolbox } from 'armorer';
import { forwardEvents } from 'lifecycle';

/**
 * Attach whatever run-owned listeners a caller wants on one toolbox instance
 * (e.g. the curated `tool.*` bubble listeners — AB-294) and return a function
 * that detaches them again. Called once for the run's base toolbox at
 * {@link createToolboxEventForwarder} construction, and again for each
 * `selectTools`-swapped step toolbox — see {@link ToolboxEventForwarder}.
 */
export type ToolboxCuratedAttacher = (toolbox: AnyToolbox) => () => void;

/**
 * Manages `toolbox.*` event forwarding — and, when an `attachCurated` is
 * supplied, any curated per-toolbox listeners a driver wants mirrored onto
 * the same bracket — for a run's full duration, including any step whose
 * `selectTools` hook swaps in a different toolbox for that step (AB-239,
 * AB-294).
 *
 * A base subscription onto the run's original toolbox is installed for the
 * run's whole lifetime — this is what {@link forwardEvents} alone gave every
 * driver before AB-239, and it still covers every step that does not swap.
 *
 * `onStepToolbox` is called TWICE per step by each driver: once with the
 * step's resolved toolbox (`options.toolbox`, or a `selectTools`
 * replacement) right after it is resolved, at step start; once with the run's
 * base toolbox right after `runStep` returns, at step end. When the resolved
 * toolbox differs from the base, the step-start call opens a second
 * subscription onto it, and the step-end call closes it again — so `call` /
 * `complete` / `budget-exceeded` / `loop-blocked` (and its companion `error`)
 * reach the run emitter with the `toolbox` prefix for exactly the duration of
 * the step that resolved that toolbox, exactly as base-toolbox events do for
 * the run's full duration. When `attachCurated` is supplied, its curated
 * listeners open and close on the identical bracket, so a swapped step
 * toolbox's `tool.started` / `tool.settled` / `tool.progress` /
 * `tool.policy-denied` bubble events reach the run emitter too (AB-294).
 *
 * Closing the swap subscription at the actual step end — not merely before
 * the NEXT step resolves ITS toolbox — matters for the durable driver: a step
 * can request a park (`ctx.waitForSignal`, `ctx.sleep`) that suspends the
 * workflow for an arbitrary duration before the next step ever runs. A
 * swapped toolbox instance held live across that park would keep forwarding
 * any activity on it — including from an unrelated run, if the instance is
 * shared — into this (possibly long-parked) run's emitter.
 *
 * When the resolved toolbox IS the base instance, no second subscription is
 * opened (for the low-level forward, or for `attachCurated`) — the base
 * subscription already covers it, so there is never duplicate delivery for
 * an unswapped step.
 */
export interface ToolboxEventForwarder {
  /**
   * Call twice per step: once at step start with that step's resolved
   * toolbox, once at step end with the run's base toolbox.
   */
  onStepToolbox(toolbox: AnyToolbox): void;
  /** Stop all forwarding — the base subscription and any active step swap. */
  stop(): void;
}

export function createToolboxEventForwarder(
  baseToolbox: AnyToolbox,
  target: EventTarget,
  attachCurated?: ToolboxCuratedAttacher,
): ToolboxEventForwarder {
  const baseForward = forwardEvents(baseToolbox, target, 'toolbox');
  const detachBaseCurated = attachCurated?.(baseToolbox);
  let swapForward: { stop(): void } | undefined;
  let detachSwapCurated: (() => void) | undefined;
  let stopped = false;

  return {
    onStepToolbox(toolbox: AnyToolbox): void {
      swapForward?.stop();
      swapForward = undefined;
      detachSwapCurated?.();
      detachSwapCurated = undefined;
      // Once `stop()` has run, `onStepToolbox` must stay a no-op — a late call
      // (e.g. a driver bug, or a step somehow resolving after cleanup) must
      // never re-open a subscription `stop()` was meant to make final.
      if (stopped || toolbox === baseToolbox) return;
      swapForward = forwardEvents(toolbox, target, 'toolbox');
      detachSwapCurated = attachCurated?.(toolbox);
    },
    stop(): void {
      stopped = true;
      baseForward.stop();
      swapForward?.stop();
      swapForward = undefined;
      detachBaseCurated?.();
      detachSwapCurated?.();
      detachSwapCurated = undefined;
    },
  };
}
