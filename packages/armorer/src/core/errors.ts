import type {
  ToolError as SharedToolError,
  ToolErrorCategory as SharedToolErrorCategory,
} from 'interoperability';

export type ToolErrorCategory = SharedToolErrorCategory;
export type ToolError = SharedToolError;

export function isToolError(value: unknown): value is ToolError {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as ToolError;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.category === 'string' &&
    typeof candidate.retryable === 'boolean' &&
    typeof candidate.message === 'string'
  );
}

/**
 * Marker attached only to a {@link ToolError} thrown by the toolbox's own
 * per-call budget accounting (`create-toolbox.ts`'s `checkBudget` path),
 * never by a tool's own `execute()` (AB-231). `ToolError.code` is public,
 * user-controlled data — a tool can throw its own error whose `code`
 * happens to normalize to `'BUDGET_EXCEEDED'` too, so `code` alone cannot
 * prove the rejection came from toolbox accounting. A consumer that needs
 * that provenance (for example, operative's toolbox-level to run-level
 * `BudgetExceededError` reclassification) checks for this symbol rather
 * than trusting `code` alone. Symbol-keyed, so it is invisible to
 * `JSON.stringify`, `Object.keys`, and structured-clone serialization — it
 * never leaks into telemetry, logs, or the wire.
 *
 * Registered via `Symbol.for` (the global symbol registry), not a bare
 * `Symbol()`, so it resolves to the identical runtime symbol across
 * separate module instances of armorer — a mixed ESM/CJS host, or a
 * dependency graph that resolves more than one armorer copy, would
 * otherwise give each copy its own private `Symbol()` and silently break
 * the provenance check for exactly the toolbox/operative pair this marker
 * exists to bridge.
 */
export const TOOLBOX_BUDGET_EXCEEDED_MARKER: unique symbol = Symbol.for(
  'armorer.toolbox-budget-exceeded',
);

/** A {@link ToolError} carrying the {@link TOOLBOX_BUDGET_EXCEEDED_MARKER} provenance marker. */
export type ToolboxBudgetExceededToolError = ToolError & {
  readonly [TOOLBOX_BUDGET_EXCEEDED_MARKER]: true;
};

/**
 * Narrows a {@link ToolError} to one carrying the toolbox's own
 * budget-accounting provenance marker, distinguishing a genuine
 * `checkBudget` rejection from a tool-defined error whose `code`
 * coincidentally also normalizes to `'BUDGET_EXCEEDED'`.
 */
export function isToolboxBudgetExceededToolError(
  error: unknown,
): error is ToolboxBudgetExceededToolError {
  return (
    isToolError(error) &&
    (error as Partial<ToolboxBudgetExceededToolError>)[TOOLBOX_BUDGET_EXCEEDED_MARKER] === true
  );
}
