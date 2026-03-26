/**
 * Portable async sleep utility. Prefers Bun.sleep() when available
 * for better precision, falling back to setTimeout for Node.js and browsers.
 *
 * All timing in the scheduler imports from this module — never call
 * Bun.sleep, setTimeout, or setInterval directly.
 */
export async function sleep(milliseconds: number): Promise<void> {
  if (typeof Bun !== 'undefined') {
    return Bun.sleep(milliseconds);
  }
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
