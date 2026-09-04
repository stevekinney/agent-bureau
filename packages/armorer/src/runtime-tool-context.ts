import type { RuntimeToolContext } from './is-tool';

/**
 * The single place a `RuntimeToolContext` built for one execution (by
 * `create-tool.ts`'s internal `execute` wrapper — the "direct"
 * `createTool(...).execute` path) is merged onto a base context for a tool
 * body.
 *
 * `create-toolbox.ts`'s `buildDefaultTool` reuses this same helper (AB-315)
 * so a toolbox-registered tool's body receives the exact same
 * `RuntimeToolContext` shape a directly-executed tool's body does — instead
 * of hand-listing each field (the shape that previously dropped `dispatch`
 * and `progress`, silently no-opping `context.progress()` for any tool
 * executed through a toolbox). Because this spreads `toolContext` wholesale
 * rather than enumerating its fields, a future field added to
 * `RuntimeToolContext` reaches both call sites automatically — the two
 * paths cannot drift apart on this again.
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
