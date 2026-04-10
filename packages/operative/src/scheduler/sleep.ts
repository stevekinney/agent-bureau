/**
 * Portable async sleep utility. Prefers Bun.sleep() when available
 * for better precision, falling back to setTimeout for Node.js and browsers.
 *
 * All timing in the scheduler imports from this module — never call
 * Bun.sleep, setTimeout, or setInterval directly.
 */
type SleepRuntime = {
  bunSleep?: (milliseconds: number) => Promise<void>;
  setTimeoutFunction?: typeof setTimeout;
};

const sleepRuntimeOverrideSymbol = Symbol.for('agent-bureau.operative.scheduler.sleep.runtime');

function resolveSleepRuntime(): SleepRuntime {
  const override = (globalThis as Record<symbol, SleepRuntime | undefined>)[
    sleepRuntimeOverrideSymbol
  ];
  if (override) return override;

  return {
    bunSleep: typeof Bun !== 'undefined' ? Bun.sleep.bind(Bun) : undefined,
    setTimeoutFunction: setTimeout,
  };
}

export async function sleep(milliseconds: number): Promise<void> {
  const runtime = resolveSleepRuntime();

  if (runtime.bunSleep) {
    return runtime.bunSleep(milliseconds);
  }
  const setTimeoutFunction = runtime.setTimeoutFunction ?? setTimeout;
  return new Promise((resolve) => setTimeoutFunction(resolve, milliseconds));
}
