import type { RuntimeToolContext } from './is-tool';

/**
 * Merges a `RuntimeToolContext` — the context `create-tool.ts`'s internal
 * `execute` wrapper builds for one execution on the "direct"
 * `createTool(...).execute` path, with `dispatch`/`progress` already wired
 * correctly for that execution — onto a base context for a tool body.
 *
 * `create-toolbox.ts`'s `buildDefaultTool` is this function's one caller
 * today (AB-315): it passes the `RuntimeToolContext` its own `createTool()`
 * call received as `toolContext`, so a toolbox-registered tool's body ends
 * up with the exact same `RuntimeToolContext` shape a directly-executed
 * tool's body would — instead of hand-listing each field (the shape that
 * previously dropped `dispatch` and `progress`, silently no-opping
 * `context.progress()` for any tool executed through a toolbox). Because
 * this spreads `toolContext` wholesale rather than enumerating its fields,
 * a future field added to `RuntimeToolContext` reaches `buildDefaultTool`'s
 * tool bodies automatically, without a matching update here — closing off
 * the class of drift that caused this bug.
 *
 * `extras` carries fields that exist alongside a `RuntimeToolContext` on a
 * tool body's context but are not themselves part of the
 * `RuntimeToolContext` type (the toolbox's own `dispatchEvent`/`emit`).
 */
export function mergeRuntimeToolContext<TExtras extends Record<string, unknown>>(
  base: Record<string, unknown>,
  toolContext: RuntimeToolContext,
  extras: TExtras,
): Record<string, unknown> {
  return {
    ...base,
    ...toolContext,
    ...extras,
  };
}
