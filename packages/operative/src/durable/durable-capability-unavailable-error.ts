/**
 * Thrown by a durable-only park tool (`scheduleWakeup`, `requestHumanInput`)
 * when invoked outside a durable run. Modeled on `NoDurableEngineError` /
 * `NoRunningRunError` (`packages/operative/src/session/session-handle.ts`)
 * but shaped to satisfy Armorer's `isToolError` guard
 * (`packages/armorer/src/core/errors.ts`) directly, so a thrown instance
 * passes through Armorer's generic execute-error catch unchanged and the
 * resulting `ToolExecutionResult.error.category` is `'unavailable'`.
 *
 * Ratified by AB-41's decision record (binding on AB-43): "An unavailable
 * capability is absent or rejects with a stable typed error." Both tool
 * factories prefer omitting themselves from the effective toolbox when the
 * composing Bureau already knows durability is unavailable; this error is
 * the fallback for a standalone `createAgent` toolbox, where no such
 * composition-time information exists.
 */
export class DurableCapabilityUnavailableError extends Error {
  readonly code = 'DurableCapabilityUnavailableError';
  readonly category = 'unavailable' as const;
  readonly retryable = false as const;

  constructor(toolName: string) {
    super(
      `${toolName}() requires a durable run (a bureau with a durable engine attached). ` +
        `This run is in-memory only and cannot park.`,
    );
    this.name = 'DurableCapabilityUnavailableError';
  }
}
