/**
 * Supplies a process-unique identifier prefix for real-runtime Cloudflare lane tests that
 * call `startCloudflareRuntime` directly (`src/test/runtime-only.test.ts`), bypassing the
 * shared `runCloudflareBackendContract` composition edge in `cloudflare-backend-contract.test.ts`.
 *
 * This lives outside `src/test/` deliberately: `scripts/check-determinism.ts` (AB-278)
 * forbids `crypto.randomUUID()` inside deterministic test directories, and per the AB-286
 * coordinator ruling this is exactly the kind of process-unique default that belongs at a
 * composition edge outside that boundary — this box runs concurrent agent validation, so two
 * processes running `runtime-only.test.ts` at once need distinguishable identifier sequences,
 * not just an incrementing counter that resets per process.
 */
export function createProcessUniqueIdentifierPrefix(): string {
  return crypto.randomUUID();
}
